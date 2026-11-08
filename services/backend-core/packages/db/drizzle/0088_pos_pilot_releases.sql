-- 0088_pos_pilot_releases.sql
--
-- RT-1292 (RT-1290 slice P1) — `[GATED: migration]` under the owner's explicit
-- authorization written into RT-1292. NEVER applied to a lab or live database
-- by this change.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-pilot-releases.openapi.yaml
--   - packages/db/src/schema/pos-pilot-releases.ts
--   - packages/db/__tests__/migration/0088-pos-pilot-releases.spec.ts
--
-- Creates TWO tables for the POS PILOT release lane. Neither shares a table,
-- a pin or a resolver with the production lane designed in RT-1260:
--
--   pos_pilot_release_registry   one row per promoted pilot release. Platform
--                                level (no tenant column), immutable except
--                                for approval, withdrawal and activation.
--   pos_pilot_tenant_allowlist   the tenants that may download the pilot
--                                release. A tenant control: per-device control
--                                happens at certificate admission and pairing.
--
-- pos_pilot_release_registry
--   * By construction, a lab or production release cannot be stored here:
--     `signing_class` admits only 'pilot', and `publisher` refuses the lab
--     markers (LAB TEST, NOT FOR PRODUCTION). The pilot publisher pin and the
--     resolver's own predicate are further layers; this table is the last.
--   * At most ONE release is current at a time: a partial unique index on the
--     rows that are approved and activated. Activating another release needs
--     the current one withdrawn first.
--   * `artifact_version_id` is the S3 VersionId the promotion workflow verified
--     (sha256 and publisher over those exact bytes); every presigned URL names
--     it, so a replaced object is never served under this row's digest.
--   * Immutability: a BEFORE UPDATE trigger refuses any change except
--     `approved` (true -> false only), `withdrawn_at`, `withdrawn_by` and, once,
--     `activated_at` / `activated_by_user_id`. A withdrawn row is never
--     re-approved: a fix ships a higher version (roll-forward). NO DELETE
--     policy.
--   * RLS: ENABLE + FORCE. SELECT is open to every context (a release is
--     platform-level and holds no tenant or personal data, as
--     pos_version_policy). INSERT and UPDATE need `app.is_platform_admin =
--     'true'`; the promotion workflow's own writer credential is decided
--     separately (RT-1260 D-5a) and adds its own policy then.
--
-- pos_pilot_tenant_allowlist
--   * One row per tenant (PK = FK -> tenants). `added_by_user_id` is a user id,
--     never an email.
--   * RLS: ENABLE + FORCE. SELECT: the tenant's own row (empty-GUC CASE guard,
--     a bare ::uuid cast throws 22P02 on an unset GUC) or the platform-admin
--     context. INSERT and DELETE: platform-admin context only. NO UPDATE policy.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-class release metadata: versions, digests, a certificate subject,
-- GitHub logins of approvers, URLs and tenant ids. No customer data, no secret.
-- The registry is kept for the life of the system (the record of what Kemetra
-- shipped to pilot terminals); an allowlist row lives while the tenant is a
-- pilot tenant and its changes stay in the append-only audit log.
-- ---------------------------------------------------------------------------
--
-- Reversal: 0088_pos_pilot_releases.down.sql. It drops ONLY these two tables
-- and the trigger function, and so DISCARDS the registry and the allowlist.
--
-- Runtime grants are provisioned outside migrations:
-- docs/operations/sql/pos-pilot-releases-domain-grants.sql (step 2 of
-- deploy/README.md), BEFORE the API that needs it starts.

BEGIN;

CREATE TABLE IF NOT EXISTS pos_pilot_release_registry (
  id                    UUID         PRIMARY KEY,
  version               TEXT         NOT NULL,
  sha256                TEXT         NOT NULL,
  size_bytes            BIGINT       NOT NULL,
  publisher             TEXT         NOT NULL,
  signing_class         TEXT         NOT NULL,
  attestation_ref       TEXT         NOT NULL,
  source_sha            TEXT         NOT NULL,
  -- The object key, never a URL. The bucket is configuration.
  artifact_key          TEXT         NOT NULL,
  artifact_version_id   TEXT         NOT NULL,
  approved              BOOLEAN      NOT NULL DEFAULT true,
  approved_at           TIMESTAMPTZ  NOT NULL,
  -- A GitHub login, never an email.
  approved_by           TEXT         NOT NULL,
  promotion_run_url     TEXT         NOT NULL,
  registered_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  withdrawn_at          TIMESTAMPTZ,
  withdrawn_by          TEXT,
  activated_at          TIMESTAMPTZ,
  activated_by_user_id  UUID         REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT pos_pilot_release_registry_version_key UNIQUE (version),
  CONSTRAINT pos_pilot_release_registry_sha256_key UNIQUE (sha256),
  CONSTRAINT pos_pilot_release_registry_artifact_key_key UNIQUE (artifact_key),
  CONSTRAINT pos_pilot_release_registry_version_shape CHECK (
    length(version) BETWEEN 5 AND 32
    AND version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
  ),
  CONSTRAINT pos_pilot_release_registry_sha256_shape CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT pos_pilot_release_registry_size_bounds CHECK (size_bytes > 0 AND size_bytes <= 2147483648),
  -- A lab or production release is unrepresentable here.
  CONSTRAINT pos_pilot_release_registry_class_pilot CHECK (signing_class = 'pilot'),
  CONSTRAINT pos_pilot_release_registry_publisher_shape CHECK (
    length(publisher) BETWEEN 1 AND 200
    AND publisher NOT ILIKE '%LAB TEST%'
    AND publisher NOT ILIKE '%NOT FOR PRODUCTION%'
  ),
  CONSTRAINT pos_pilot_release_registry_attestation_shape CHECK (
    length(attestation_ref) <= 200
    AND attestation_ref ~ '^https://github\.com/Kemetra-Labs/Retail-Tower-Erp/attestations/[0-9]+$'
  ),
  CONSTRAINT pos_pilot_release_registry_source_sha_shape CHECK (source_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT pos_pilot_release_registry_artifact_key_shape CHECK (
    artifact_key = 'pos/pilot/' || version || '/POS-Pulse-Setup-' || version || '.exe'
  ),
  CONSTRAINT pos_pilot_release_registry_version_id_shape CHECK (length(artifact_version_id) BETWEEN 1 AND 1024),
  CONSTRAINT pos_pilot_release_registry_approved_by_shape CHECK (
    length(approved_by) <= 39 AND approved_by ~ '^[A-Za-z0-9](-?[A-Za-z0-9])*$'
  ),
  CONSTRAINT pos_pilot_release_registry_run_url_shape CHECK (
    length(promotion_run_url) <= 200
    AND promotion_run_url ~ '^https://github\.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/[0-9]+(/attempts/[0-9]+)?$'
  ),
  CONSTRAINT pos_pilot_release_registry_withdrawn_consistent CHECK (approved = (withdrawn_at IS NULL)),
  CONSTRAINT pos_pilot_release_registry_withdrawn_by_consistent CHECK (
    (withdrawn_at IS NULL) = (withdrawn_by IS NULL)
    AND (withdrawn_by IS NULL OR (length(withdrawn_by) <= 39 AND withdrawn_by ~ '^[A-Za-z0-9](-?[A-Za-z0-9])*$'))
  ),
  CONSTRAINT pos_pilot_release_registry_activated_consistent CHECK (
    (activated_at IS NULL) = (activated_by_user_id IS NULL)
  )
);

-- At most one current (approved and activated) pilot release.
CREATE UNIQUE INDEX IF NOT EXISTS pos_pilot_release_registry_one_current
  ON pos_pilot_release_registry ((true))
  WHERE approved AND activated_at IS NOT NULL;

CREATE OR REPLACE FUNCTION pos_pilot_release_registry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['approved', 'withdrawn_at', 'withdrawn_by', 'activated_at', 'activated_by_user_id'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['approved', 'withdrawn_at', 'withdrawn_by', 'activated_at', 'activated_by_user_id']) THEN
    RAISE EXCEPTION 'pos_pilot_release_registry: a release is immutable except approval, withdrawal and activation'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.approved = false AND NEW.approved = true THEN
    RAISE EXCEPTION 'pos_pilot_release_registry: a withdrawn release is never re-approved'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.activated_at IS NOT NULL
     AND (NEW.activated_at IS DISTINCT FROM OLD.activated_at
          OR NEW.activated_by_user_id IS DISTINCT FROM OLD.activated_by_user_id) THEN
    RAISE EXCEPTION 'pos_pilot_release_registry: activation is recorded once and never cleared'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pos_pilot_release_registry_guard ON pos_pilot_release_registry;
CREATE TRIGGER pos_pilot_release_registry_guard
  BEFORE UPDATE ON pos_pilot_release_registry
  FOR EACH ROW EXECUTE FUNCTION pos_pilot_release_registry_guard();

ALTER TABLE pos_pilot_release_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_pilot_release_registry FORCE  ROW LEVEL SECURITY;

-- Platform-level release metadata: any context may read it.
CREATE POLICY pos_pilot_release_registry_read ON pos_pilot_release_registry
  FOR SELECT
  USING (true);

-- Only the platform-admin context may register, withdraw or activate a release.
CREATE POLICY pos_pilot_release_registry_platform_insert ON pos_pilot_release_registry
  FOR INSERT
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE POLICY pos_pilot_release_registry_platform_update ON pos_pilot_release_registry
  FOR UPDATE
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

CREATE TABLE IF NOT EXISTS pos_pilot_tenant_allowlist (
  tenant_id          UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  -- A user id, never an email.
  added_by_user_id   UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  added_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE pos_pilot_tenant_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_pilot_tenant_allowlist FORCE  ROW LEVEL SECURITY;

-- A tenant context reads only its own row (the resolver); the platform-admin
-- context reads all. The empty-GUC CASE guard avoids a 22P02 on an unset GUC.
CREATE POLICY pos_pilot_tenant_allowlist_read ON pos_pilot_tenant_allowlist
  FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

CREATE POLICY pos_pilot_tenant_allowlist_platform_insert ON pos_pilot_tenant_allowlist
  FOR INSERT
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- NO UPDATE policy: an entry is added or removed, never edited.
CREATE POLICY pos_pilot_tenant_allowlist_platform_delete ON pos_pilot_tenant_allowlist
  FOR DELETE
  USING (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;
