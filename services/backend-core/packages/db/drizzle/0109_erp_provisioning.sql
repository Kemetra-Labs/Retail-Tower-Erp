-- 0109_erp_provisioning.sql
--
-- RT-1357 (Epic RT-1332; RT-1352 breakdown item PB-B) — `[GATED: migration]`.
-- Source: the owner-approved RT-1352 design (Confluence page 76152835, v4,
-- sections 4.4, 4.7, 4.9, 4.11, 8) and the merged contract
-- packages/contracts/openapi/erpnext-connector/provisioning-feed.yaml
-- (RT-1356, #564). Applying it to a lab or live database is NOT authorized by
-- this change. Storage and constraints only: no service, controller, contract,
-- Connector, backfill or store flag (PB-C, PB-D and PC-A own those).
--
-- Source-of-truth artifacts:
--   - packages/db/src/schema/erp-provisioning.ts
--   - packages/db/__tests__/migration/0109-erp-provisioning.spec.ts
--   - docs/operations/sql/erp-provisioning-domain-grants.sql
--
-- WHAT IT ADDS (additive: existing tenants and registrations behave as before)
--   1. erp_provisioning_request   one row per provisioning request; status,
--      lease, backoff, attempt floor and an optimistic-concurrency `version`.
--      A partial unique index allows one ACTIVE `tenant.provision` request per
--      tenant.
--   2. erp_provisioning_step_log  append-only record of every step
--      acknowledgement; UNIQUE (request, step, attempt) IS the idempotency key.
--   3. erp_provisioner_credential the platform-scope provisioner credential per
--      ERP host (host label + environment). One live row per host label. The
--      secret hash stays in auth_tokens; nothing secret is stored here.
--   4. connector_registration.managed_by   nullable; existing rows stay NULL.
--   5. auth_tokens_scope_valid gains the scope `connector_provisioner`, with
--      its principal-consistency CHECK (platform scope: no tenant, no device,
--      no store, no registration; the user is the system actor).
--   6. A seeded system actor (fixed id) that cannot sign in. A CHECK on `users`
--      keeps it that way (no password hash, no external identity, never a
--      platform admin); it has no membership rows, so it never appears in a
--      membership list. Listing queries are untouched (PB-C: do not surface it).
--
-- RLS POSTURE (FORCE RLS on all three new tables, the 0036 CASE-GUC form so an
-- unset or empty GUC never raises 22P02 and fails closed)
--   * A NEW session setting, `app.is_provisioner = 'true'`, is the provisioner
--     machine bearer's authority. PB-C sets it ONLY on the provisioner-bearer
--     path, never together with `app.is_platform_admin`. It is used by the
--     policies of these three tables and nowhere else, so a provisioner session
--     cannot write tenant_access_entitlements or any other table (tested).
--   * erp_provisioning_request:
--       SELECT  own tenant (app.current_tenant) | platform admin | provisioner
--       INSERT  platform admin only (Backend-Core creates the request in the
--               platform context at unlock) and only as a clean `requested` row
--       UPDATE  provisioner (lease, status, backoff) | platform admin (operator
--               cancel, restart; the Console routes are RT-1333 item 6)
--       DELETE  none
--     The provisioner and platform-admin policies are NOT pinned to a tenant
--     GUC: the feed reads and acknowledges across tenants.
--   * erp_provisioning_step_log: SELECT as above; INSERT provisioner only; no
--     UPDATE or DELETE (a trigger also refuses both, for any role).
--   * erp_provisioner_credential: platform admin only (SELECT, INSERT, UPDATE).
--     The provisioner never reads it through RLS; the bearer verifier (PB-C)
--     resolves the token through auth_tokens.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-class operational state: ids, enum tokens, a site name derived from
-- the tenant id, a template id and version, counters and timestamps. The
-- scrubbed `last_reason` and `detail` are short operator text the provisioner
-- has already stripped of secrets, tokens, passwords and tenant business
-- content (contract). NO PII, NO money, NO secret, NO hash. Retained for the
-- life of the tenant; no row is ever deleted.
-- ---------------------------------------------------------------------------
--
-- Reversal: 0109_erp_provisioning.down.sql. It REFUSES while any request,
-- credential, provisioner token or managed registration exists, so it cannot
-- discard provisioning history silently.
--
-- Runtime grants are provisioned outside migrations:
-- docs/operations/sql/erp-provisioning-domain-grants.sql (step 2 of
-- deploy/README.md), BEFORE the API that needs them starts.
--
-- Lock discipline (the 0103 pattern): the first transaction takes short
-- catalog locks under lock_timeout 2s and adds every CHECK on an existing table
-- as NOT VALID; each VALIDATE runs afterwards in its own transaction under SHARE
-- UPDATE EXCLUSIVE, so no long ACCESS EXCLUSIVE is held on users, auth_tokens
-- or connector_registration.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- 1. The system actor ------------------------------------------------------
-- Fixed id (RT-1357 in the last group) so the auth_tokens CHECK below can name
-- it. Reserved `.invalid` email, no password hash, no external identity link, no
-- membership: it cannot sign in by any path.
INSERT INTO users (id, email, display_name, password_hash, clerk_user_id, is_platform_admin)
VALUES ('00000000-0000-7000-8000-000000001357', 'system-provisioning@system.invalid',
        'System (provisioning)', NULL, NULL, false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE users
  ADD CONSTRAINT users_system_actor_no_login
    CHECK (id <> '00000000-0000-7000-8000-000000001357'
           OR (password_hash IS NULL AND clerk_user_id IS NULL AND is_platform_admin = false))
    NOT VALID;

-- 2. connector_registration.managed_by -------------------------------------
ALTER TABLE connector_registration ADD COLUMN IF NOT EXISTS managed_by TEXT;

ALTER TABLE connector_registration
  ADD CONSTRAINT connector_registration_managed_by_valid
    CHECK (managed_by IS NULL OR managed_by = 'provisioner')
    NOT VALID;

-- 3. auth_tokens: the provisioner scope ------------------------------------
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_scope_valid;

ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_scope_valid
    CHECK (scope IN (
      'dashboard_api', 'pos', 'pos_operator',
      'connector', 'password_reset', 'email_verify',
      'connector_provisioner'
    ))
    NOT VALID;

-- Platform scope: tenant-independent, owned by the system actor, tied to no
-- tenant, device, store or registration. (The existing
-- auth_tokens_principal_by_scope CHECK already demands exactly one of user or
-- device for this scope, so the user is mandatory.)
ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_provisioner_shape
    CHECK (scope <> 'connector_provisioner'
           OR (tenant_id IS NULL
               AND user_id = '00000000-0000-7000-8000-000000001357'
               AND device_id IS NULL
               AND store_id IS NULL
               AND connector_registration_id IS NULL))
    NOT VALID;

-- 4. erp_provisioning_request ----------------------------------------------
CREATE TABLE IF NOT EXISTS erp_provisioning_request (
  id                         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind                       TEXT         NOT NULL,
  -- Increments only when an operator restarts a request after compensation.
  generation                 INTEGER      NOT NULL DEFAULT 1,
  status                     TEXT         NOT NULL DEFAULT 'requested',
  -- Retries of the current step (backoff cap); the contract allows three
  -- transient retries per step.
  attempt                    INTEGER      NOT NULL DEFAULT 0,
  -- The highest step `attempt` recorded for this request across all steps (the
  -- contract's attemptFloor): the next acknowledgement must send a greater one.
  attempt_floor              INTEGER      NOT NULL DEFAULT 0,
  -- The lease: holder is the ERP host label of the provisioner; all three set
  -- or none.
  lease_holder               TEXT,
  lease_id                   UUID,
  lease_expires_at           TIMESTAMPTZ,
  -- Retry backoff / capacity hold: pull does not offer the request before it.
  not_before                 TIMESTAMPTZ,
  last_error_class           TEXT,
  last_reason                TEXT,
  -- Derived by Backend-Core from the tenant id (never slug or business name).
  site_name                  TEXT         NOT NULL,
  -- The code-owned versioned template, frozen into the request.
  template_id                TEXT         NOT NULL,
  template_version           INTEGER      NOT NULL,
  -- The managed registration the credential operation issues for.
  connector_registration_id  UUID         REFERENCES connector_registration(id) ON DELETE RESTRICT,
  -- Optimistic concurrency: a trigger bumps it on every UPDATE.
  version                    INTEGER      NOT NULL DEFAULT 1,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  terminal_at                TIMESTAMPTZ,
  -- Composite-FK target so a step-log row cannot name another tenant.
  CONSTRAINT uq_erp_provisioning_request_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT erp_provisioning_request_kind_valid
    CHECK (kind IN ('tenant.provision', 'store.provision', 'credential.rotate')),
  CONSTRAINT erp_provisioning_request_status_valid
    CHECK (status IN (
      'requested', 'claimed', 'site_created', 'erp_configured', 'connector_installed',
      'credential_bound', 'verifying', 'succeeded',
      'failed_retryable', 'failed_permanent', 'compensating', 'compensated', 'cancelled'
    )),
  CONSTRAINT erp_provisioning_request_counters_valid
    CHECK (generation >= 1 AND attempt >= 0 AND attempt_floor >= 0 AND template_version >= 1 AND version >= 1),
  CONSTRAINT erp_provisioning_request_lease_all_or_none
    CHECK ((lease_holder IS NULL) = (lease_id IS NULL) AND (lease_id IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT erp_provisioning_request_terminal_at_matches_status
    CHECK ((terminal_at IS NOT NULL)
           = (status IN ('succeeded', 'failed_permanent', 'compensated', 'cancelled'))),
  CONSTRAINT erp_provisioning_request_last_error_class_valid
    CHECK (last_error_class IS NULL OR last_error_class IN (
      'failed_transient', 'permanently_rejected', 'conflict', 'capacity', 'compatibility', 'dependency')),
  CONSTRAINT erp_provisioning_request_text_bounds
    CHECK (length(site_name) BETWEEN 1 AND 128
           AND length(template_id) BETWEEN 1 AND 64
           AND (lease_holder IS NULL OR length(lease_holder) BETWEEN 1 AND 64)
           AND (last_reason IS NULL OR length(last_reason) BETWEEN 1 AND 200))
);

-- One active `tenant.provision` request per tenant (a second unlock returns
-- the same request). Terminal: succeeded, failed_permanent, compensated,
-- cancelled. The predicate is IMMUTABLE (no now()).
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_provisioning_request_active_tenant_provision
  ON erp_provisioning_request (tenant_id)
  WHERE kind = 'tenant.provision'
    AND status NOT IN ('succeeded', 'failed_permanent', 'compensated', 'cancelled');

-- The pull: non-terminal requests, oldest first.
CREATE INDEX IF NOT EXISTS idx_erp_provisioning_request_pull
  ON erp_provisioning_request (created_at)
  WHERE status NOT IN ('succeeded', 'failed_permanent', 'compensated', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_erp_provisioning_request_tenant
  ON erp_provisioning_request (tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_erp_provisioning_request_registration
  ON erp_provisioning_request (connector_registration_id)
  WHERE connector_registration_id IS NOT NULL;

-- Fixed identity and monotonic counters; `version` and `updated_at` always move.
CREATE OR REPLACE FUNCTION erp_provisioning_request_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kind <> OLD.kind
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'erp_provisioning_request: id, tenant_id, kind and created_at are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'erp_provisioning_request: generation never decreases'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempt_floor < OLD.attempt_floor THEN
    RAISE EXCEPTION 'erp_provisioning_request: attempt_floor never decreases'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER erp_provisioning_request_guard
  BEFORE UPDATE ON erp_provisioning_request
  FOR EACH ROW EXECUTE FUNCTION erp_provisioning_request_guard();

-- 5. erp_provisioning_step_log (append-only) --------------------------------
CREATE TABLE IF NOT EXISTS erp_provisioning_step_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID         NOT NULL,
  tenant_id     UUID         NOT NULL,
  generation    INTEGER      NOT NULL,
  step          TEXT         NOT NULL,
  outcome       TEXT         NOT NULL,
  attempt       INTEGER      NOT NULL,
  error_class   TEXT,
  reason        TEXT,
  detail        TEXT,
  lease_id      UUID,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- tenant_id must equal the request's tenant.
  CONSTRAINT erp_provisioning_step_log_request_fk
    FOREIGN KEY (request_id, tenant_id)
    REFERENCES erp_provisioning_request (id, tenant_id) ON DELETE RESTRICT,
  -- The idempotency key `{requestId}:{step}:{attempt}`.
  CONSTRAINT uq_erp_provisioning_step_log_request_step_attempt
    UNIQUE (request_id, step, attempt),
  CONSTRAINT erp_provisioning_step_log_step_valid
    CHECK (step IN ('claimed', 'site_created', 'erp_configured', 'connector_installed',
                    'credential_bound', 'verified')),
  CONSTRAINT erp_provisioning_step_log_outcome_valid
    CHECK (outcome IN ('done', 'failed_transient', 'permanently_rejected', 'conflict',
                       'capacity', 'compatibility', 'dependency')),
  CONSTRAINT erp_provisioning_step_log_shape
    CHECK (generation >= 1 AND attempt >= 1
           AND ((outcome = 'done') = (error_class IS NULL))
           AND (error_class IS NULL OR error_class = outcome)
           AND (outcome <> 'permanently_rejected' OR reason IS NOT NULL)
           AND (reason IS NULL OR length(reason) BETWEEN 1 AND 200)
           AND (detail IS NULL OR length(detail) <= 1000))
);

CREATE INDEX IF NOT EXISTS idx_erp_provisioning_step_log_request
  ON erp_provisioning_step_log (request_id, created_at);

CREATE OR REPLACE FUNCTION erp_provisioning_step_log_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'erp_provisioning_step_log is append-only'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER erp_provisioning_step_log_append_only
  BEFORE UPDATE OR DELETE ON erp_provisioning_step_log
  FOR EACH ROW EXECUTE FUNCTION erp_provisioning_step_log_append_only();

-- 6. erp_provisioner_credential --------------------------------------------
CREATE TABLE IF NOT EXISTS erp_provisioner_credential (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  host_label   TEXT         NOT NULL,
  -- The deployment the bearer is valid for (the contract's 403 on a mismatch).
  environment  TEXT         NOT NULL,
  -- The auth_tokens row that carries the secret HASH (scope connector_provisioner).
  token_id     UUID         NOT NULL REFERENCES auth_tokens(id) ON DELETE RESTRICT,
  issued_by    UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  revoked_by   UUID         REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT uq_erp_provisioner_credential_token UNIQUE (token_id),
  CONSTRAINT erp_provisioner_credential_host_label_valid
    CHECK (host_label ~ '^[a-z0-9][a-z0-9-]*$' AND length(host_label) <= 64),
  CONSTRAINT erp_provisioner_credential_environment_valid
    CHECK (environment IN ('dev', 'staging', 'pilot', 'prod')),
  CONSTRAINT erp_provisioner_credential_revocation_pair
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- One live (unrevoked) credential per host label. Expiry is NOT in the
-- predicate (now() is STABLE): the service revokes an expired row when it
-- issues the replacement, in the same transaction (the 0021 precedent).
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_provisioner_credential_live_host
  ON erp_provisioner_credential (host_label)
  WHERE revoked_at IS NULL;

-- 7. Row-level security -----------------------------------------------------
ALTER TABLE erp_provisioning_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_provisioning_request FORCE  ROW LEVEL SECURITY;

CREATE POLICY erp_provisioning_request_tenant_select ON erp_provisioning_request
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY erp_provisioning_request_platform_select ON erp_provisioning_request
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY erp_provisioning_request_provisioner_select ON erp_provisioning_request
  FOR SELECT USING (current_setting('app.is_provisioner', true) = 'true');

-- A request is only ever CREATED as a clean `requested` row, by a platform
-- admin (the unlock transaction); the provisioner moves it afterwards.
CREATE POLICY erp_provisioning_request_platform_insert ON erp_provisioning_request
  FOR INSERT WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    AND status = 'requested'
    AND generation = 1 AND attempt = 0 AND attempt_floor = 0
    AND lease_id IS NULL AND terminal_at IS NULL);

CREATE POLICY erp_provisioning_request_provisioner_update ON erp_provisioning_request
  FOR UPDATE
  USING (current_setting('app.is_provisioner', true) = 'true')
  WITH CHECK (current_setting('app.is_provisioner', true) = 'true');

CREATE POLICY erp_provisioning_request_platform_update ON erp_provisioning_request
  FOR UPDATE
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

ALTER TABLE erp_provisioning_step_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_provisioning_step_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY erp_provisioning_step_log_tenant_select ON erp_provisioning_step_log
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY erp_provisioning_step_log_platform_select ON erp_provisioning_step_log
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY erp_provisioning_step_log_provisioner_select ON erp_provisioning_step_log
  FOR SELECT USING (current_setting('app.is_provisioner', true) = 'true');

CREATE POLICY erp_provisioning_step_log_provisioner_insert ON erp_provisioning_step_log
  FOR INSERT WITH CHECK (current_setting('app.is_provisioner', true) = 'true');

ALTER TABLE erp_provisioner_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_provisioner_credential FORCE  ROW LEVEL SECURITY;

CREATE POLICY erp_provisioner_credential_platform_select ON erp_provisioner_credential
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY erp_provisioner_credential_platform_insert ON erp_provisioner_credential
  FOR INSERT WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY erp_provisioner_credential_platform_update ON erp_provisioner_credential
  FOR UPDATE
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;

-- Each VALIDATE in its own transaction with the same lock bound (SHARE UPDATE
-- EXCLUSIVE: reads and writes continue while the scan runs).
BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE users VALIDATE CONSTRAINT users_system_actor_no_login;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE connector_registration VALIDATE CONSTRAINT connector_registration_managed_by_valid;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE auth_tokens VALIDATE CONSTRAINT auth_tokens_scope_valid;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE auth_tokens VALIDATE CONSTRAINT auth_tokens_provisioner_shape;
COMMIT;
