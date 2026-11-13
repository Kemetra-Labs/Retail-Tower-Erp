-- 0108_pending_signups.sql
--
-- RT-1350 slice 2 (Epic RT-1332; design RT-1333 v6 section 4, decisions D1, D3,
-- D5, D6) — `[GATED: migration]`. Applying it to a lab or live database is NOT
-- authorized by this change.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/signups.openapi.yaml (slice 1, contract-only)
--   - packages/db/src/schema/pending-signups.ts, user-consents.ts
--   - packages/db/__tests__/migration/0108-pending-signups.spec.ts
--
-- Creates TWO tables and nothing else (no controller, service or worker):
--
--   pending_signups  a signup that has been requested and not yet completed.
--                    PRE-TENANT: there is no tenant until `completeSignup`.
--   user_consents    the durable consent record, keyed to the USER (design D6:
--                    "on the user"), written by the signup service when the
--                    signup completes. Append-only.
--
-- Design points the columns follow:
--   - D1: the signup token is opaque. Under D1-B (provider-sent sign-up link)
--     Backend-Core stores no token, so `token_hash` stays NULL. Under the
--     fallback D1-A (Backend-Core's own emailed token) it holds the HASH of the
--     token, never the token. Both fit this schema.
--   - D3: one pending row per normalized email while it is `pending`
--     (partial unique index). `tenant_id` + `completed_at` + `status =
--     'completed'` record which tenant a completed signup created, so a lost
--     201 can be answered idempotently. A rollback after the provider steps
--     leaves the row `pending`.
--   - D5: the rate-limit buckets are Redis buckets, so there are NO counter
--     columns here.
--   - D6: `terms_version`, `terms_accepted_at` and `ip_hash` are the request-time
--     consent; `user_consents` is the durable copy.
--
-- RLS (both tables): ENABLE + FORCE, NO tenant policy. These rows are not
-- tenant data, so a tenant session sees nothing. The only policies are
-- platform-scoped, `app.is_platform_admin = 'true'` (no tenant GUC is read, so
-- the 0036 CASE-GUC form is not needed): the signup service runs in a
-- platform-admin context. pending_signups: SELECT, INSERT, UPDATE (no DELETE
-- policy yet: the purge job of a later slice adds its own). user_consents:
-- SELECT, INSERT only (append-only: no UPDATE, no DELETE).
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (section XIV)
-- ---------------------------------------------------------------------------
-- pending_signups: PII-CLASS (email, name, business name, hashed client IP).
--   Retention (design D5): a row expires 24 h after it is created
--   (`expires_at`) and is hard-deleted 7 days after that, by the purge job of a
--   later slice (not built here; the `expires_at` index serves it). A completed
--   row carries the same horizon unless the purge job decides otherwise.
--   The 45-day soft-delete of design D5.1 concerns abandoned restricted
--   TENANTS (`tenants.deleted_at`), not these rows.
-- user_consents: COMPLIANCE-CLASS (terms version, acceptance time, hashed IP).
--   Retained for the life of the user (a legal record of what was accepted).
--   `ip_hash` is a hash, never the address. NO secret, NO free text.
-- ---------------------------------------------------------------------------
--
-- Reversal: 0108_pending_signups.down.sql drops both tables, and so DISCARDS
-- every pending signup and every consent record. Roll back the signup service
-- first.
--
-- Runtime grants are provisioned outside migrations:
-- docs/operations/sql/pending-signups-domain-grants.sql (step 2 of
-- deploy/README.md), BEFORE the API that needs it starts.

BEGIN;

-- The foreign keys take SHARE ROW EXCLUSIVE locks on `tenants` and `users`.
-- lock_timeout 2s: if a lock is not granted in time the migration fails and
-- rolls back, instead of queueing behind a long transaction (0097/0101/0105).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS pending_signups (
  id                 UUID         PRIMARY KEY,
  -- Lower-cased, trimmed by the service; the CHECK below enforces that much.
  email_normalized   TEXT         NOT NULL,
  name               TEXT         NOT NULL,
  business_name      TEXT         NOT NULL,
  locale             TEXT,
  terms_version      TEXT         NOT NULL,
  terms_accepted_at  TIMESTAMPTZ  NOT NULL,
  ip_hash            TEXT         NOT NULL,
  -- NULL under D1-B; the hash of Backend-Core's own token under fallback D1-A.
  token_hash         TEXT,
  status             TEXT         NOT NULL DEFAULT 'pending',
  -- The tenant a completed signup created. NULL until then.
  tenant_id          UUID         REFERENCES tenants(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ  NOT NULL,
  completed_at       TIMESTAMPTZ,
  CONSTRAINT pending_signups_status_valid
    CHECK (status IN ('pending', 'completed', 'expired')),
  CONSTRAINT pending_signups_locale_valid
    CHECK (locale IS NULL OR locale IN ('ar', 'en')),
  CONSTRAINT pending_signups_email_normalized_shape
    CHECK (email_normalized = lower(btrim(email_normalized))
           AND char_length(email_normalized) BETWEEN 3 AND 254),
  CONSTRAINT pending_signups_name_length
    CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT pending_signups_business_name_length
    CHECK (char_length(business_name) BETWEEN 1 AND 120),
  CONSTRAINT pending_signups_terms_version_length
    CHECK (char_length(terms_version) BETWEEN 1 AND 64),
  CONSTRAINT pending_signups_ip_hash_length
    CHECK (char_length(ip_hash) BETWEEN 1 AND 128),
  CONSTRAINT pending_signups_token_hash_length
    CHECK (token_hash IS NULL OR char_length(token_hash) BETWEEN 1 AND 128),
  CONSTRAINT pending_signups_expiry_after_creation
    CHECK (expires_at > created_at),
  -- `completed` carries the tenant and the time; `pending` and `expired` carry neither.
  CONSTRAINT pending_signups_state_shape
    CHECK (
      (status = 'completed' AND tenant_id IS NOT NULL AND completed_at IS NOT NULL)
      OR
      (status IN ('pending', 'expired') AND tenant_id IS NULL AND completed_at IS NULL)
    )
);

-- At most one PENDING signup per normalized email (D3). A completed or expired
-- row does not block a new signup for the same address.
CREATE UNIQUE INDEX IF NOT EXISTS pending_signups_email_pending_uniq
  ON pending_signups (email_normalized)
  WHERE status = 'pending';

-- Lookup by email for every status (the idempotent answer after a lost 201,
-- the per-email checks).
CREATE INDEX IF NOT EXISTS pending_signups_email_idx
  ON pending_signups (email_normalized);

-- Fallback D1-A: the token is found by its hash. Unused (NULL) under D1-B.
CREATE UNIQUE INDEX IF NOT EXISTS pending_signups_token_hash_uniq
  ON pending_signups (token_hash)
  WHERE token_hash IS NOT NULL;

-- The purge job of a later slice walks rows by expiry.
CREATE INDEX IF NOT EXISTS pending_signups_expires_at_idx
  ON pending_signups (expires_at);

-- One forward path: pending -> completed | expired, and nothing else. The
-- identity and consent columns never change; while pending, only the token
-- hash and the expiry may move (a fresh link for the same pending signup);
-- a completed or expired row is frozen.
CREATE OR REPLACE FUNCTION pending_signups_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.email_normalized <> OLD.email_normalized
     OR NEW.name <> OLD.name
     OR NEW.business_name <> OLD.business_name
     OR NEW.locale IS DISTINCT FROM OLD.locale
     OR NEW.terms_version <> OLD.terms_version
     OR NEW.terms_accepted_at <> OLD.terms_accepted_at
     OR NEW.ip_hash <> OLD.ip_hash
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'pending_signups: the identity and consent columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'pending_signups: a % signup is never changed', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pending_signups_guard
  BEFORE UPDATE ON pending_signups
  FOR EACH ROW EXECUTE FUNCTION pending_signups_guard();

CREATE TABLE IF NOT EXISTS user_consents (
  id                 UUID         PRIMARY KEY,
  user_id            UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  terms_version      TEXT         NOT NULL,
  accepted_at        TIMESTAMPTZ  NOT NULL,
  ip_hash            TEXT         NOT NULL,
  source             TEXT         NOT NULL,
  -- Provenance only. A purged pending row must not block, or erase, the
  -- consent record: the link just goes NULL (a referential action, which row
  -- security does not apply to).
  pending_signup_id  UUID         REFERENCES pending_signups(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT user_consents_source_valid
    CHECK (source IN ('self_signup')),
  CONSTRAINT user_consents_terms_version_length
    CHECK (char_length(terms_version) BETWEEN 1 AND 64),
  CONSTRAINT user_consents_ip_hash_length
    CHECK (char_length(ip_hash) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS user_consents_user_idx
  ON user_consents (user_id);

-- Provenance lookups, and the ON DELETE SET NULL scan when the purge runs.
CREATE INDEX IF NOT EXISTS user_consents_pending_signup_idx
  ON user_consents (pending_signup_id)
  WHERE pending_signup_id IS NOT NULL;

ALTER TABLE pending_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_signups FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_consents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_consents   FORCE  ROW LEVEL SECURITY;

-- Platform scope only: no tenant policy exists, so a tenant session reads and
-- writes nothing. A bare current_setting(..., true) is safe here (it yields
-- NULL or '' when unset, never a cast error).
CREATE POLICY pending_signups_platform_select ON pending_signups
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY pending_signups_platform_insert ON pending_signups
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY pending_signups_platform_update ON pending_signups
  FOR UPDATE
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY user_consents_platform_select ON user_consents
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY user_consents_platform_insert ON user_consents
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;
