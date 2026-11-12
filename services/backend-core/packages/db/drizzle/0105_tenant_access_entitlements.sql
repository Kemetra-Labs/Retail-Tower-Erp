-- 0105_tenant_access_entitlements.sql
--
-- RT-1353 (Epic RT-1332; design RT-1333 D2 = B, P2) — `[GATED: migration]`.
-- Owner authority: the owner selected "RT-1353 entitlement" for wave 1 with
-- "PR and merge authorized after Opus review" (2026-11-12); the RT-1001
-- agreement to pull this slice forward is RT-1001 comment 16753. Applying it
-- to a lab or live database is NOT authorized by this change.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/tenant-access-entitlement.openapi.yaml
--   - packages/db/src/schema/tenant-access-entitlements.ts
--   - packages/db/__tests__/migration/0105-tenant-access-entitlements.spec.ts
--
-- Creates ONE table, `tenant_access_entitlements`: the tenant's access state,
-- `restricted` or `unrestricted` and nothing else (packages, quotas, billing
-- and the POS licence proof stay with RT-1001). A self-signup tenant is
-- `active` but `restricted` until a platform admin unlocks it and provisioning
-- succeeds (RT-1333 D2 / D2.1). This is NOT a `tenants.status` value: the
-- RT-669 / RT-213 tenant-status gate is unchanged.
--
-- DEFAULT SEMANTICS (the rule every reader shares): a tenant with NO row is
-- `unrestricted`. So this migration needs NO backfill and every existing
-- (pilot) tenant reads `unrestricted` by construction; nothing changes for
-- them. Only a tenant that is explicitly restricted has a row (the signup
-- transaction of RT-1350 inserts it). Rows are never deleted.
--
-- Row lifecycle (one forward path, enforced by CHECKs and a trigger):
--   restricted, no unlock request
--     -> restricted, unlock requested   (platform admin; records who and when;
--                                        the durable provisioning trigger that
--                                        the Connector-provisioning issue,
--                                        RT-1352, will consume)
--     -> unrestricted, provisioned      (platform admin "mark provisioned" until
--                                        automated provisioning exists)
--   `unrestricted` never goes back to `restricted` here, and an unlock request
--   is never cleared.
--
-- RLS: ENABLE + FORCE, the 0036 CASE-GUC form (a bare ::uuid cast throws 22P02
-- on an unset GUC). A tenant may READ its own row. INSERT and UPDATE need
-- `app.is_platform_admin = 'true'` inside the target tenant's context, so a
-- tenant can never lift its own restriction (the AI entitlement pattern,
-- 0055 D-2 / T18). No DELETE policy.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS tenant configuration: an enum state, two actor ids (platform
-- admin user ids, FK to users) and timestamps. NO PII, NO money, NO secret,
-- NO free text. Retained for the life of the tenant.
-- ---------------------------------------------------------------------------
--
-- Reversal: 0105_tenant_access_entitlements.down.sql drops ONLY this table and
-- its trigger function, and so DISCARDS every restriction (a restricted tenant
-- then reads `unrestricted`).
--
-- Runtime grants are provisioned outside migrations:
-- docs/operations/sql/tenant-access-entitlements-domain-grants.sql (step 2 of
-- deploy/README.md), BEFORE the API that needs it starts.

BEGIN;

-- The foreign keys below take SHARE ROW EXCLUSIVE locks on `tenants` and
-- `users`. lock_timeout 2s: if a lock is not granted in time the migration
-- fails and rolls back, instead of queueing behind a long transaction and
-- blocking every sign-in and session write (the 0097, 0101 and 0103 pattern).
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS tenant_access_entitlements (
  tenant_id                    UUID         PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  state                        TEXT         NOT NULL,
  -- The unlock request: the durable provisioning trigger (set together, once).
  unlock_requested_at          TIMESTAMPTZ,
  unlock_requested_by_user_id  UUID         REFERENCES users(id) ON DELETE RESTRICT,
  -- The provisioning result: set exactly when the state is `unrestricted`.
  provisioned_at               TIMESTAMPTZ,
  provisioned_by_user_id       UUID         REFERENCES users(id) ON DELETE RESTRICT,
  provisioning_source          TEXT,
  created_at                   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tenant_access_entitlements_state_valid
    CHECK (state IN ('restricted', 'unrestricted')),
  CONSTRAINT tenant_access_entitlements_unlock_request_pair
    CHECK ((unlock_requested_at IS NULL) = (unlock_requested_by_user_id IS NULL)),
  CONSTRAINT tenant_access_entitlements_provisioning_source_valid
    CHECK (provisioning_source IS NULL OR provisioning_source IN ('manual_platform')),
  -- `restricted` carries no provisioning result; `unrestricted` carries all of
  -- it, and only after an unlock was requested.
  CONSTRAINT tenant_access_entitlements_state_shape
    CHECK (
      (state = 'restricted'
        AND provisioned_at IS NULL AND provisioned_by_user_id IS NULL AND provisioning_source IS NULL)
      OR
      (state = 'unrestricted'
        AND unlock_requested_at IS NOT NULL
        AND provisioned_at IS NOT NULL AND provisioning_source IS NOT NULL
        AND (provisioning_source <> 'manual_platform' OR provisioned_by_user_id IS NOT NULL))
    )
);

-- One forward path (see the header): the tenant never changes, `unrestricted`
-- needs an unlock request recorded first and never goes back, the provisioning
-- result and an unlock request are never cleared or rewritten, and
-- `updated_at` moves on every change.
CREATE OR REPLACE FUNCTION tenant_access_entitlements_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_access_entitlements: tenant_id is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'unrestricted' AND NEW.state <> 'unrestricted' THEN
    RAISE EXCEPTION 'tenant_access_entitlements: an unrestricted tenant is never restricted again here'
      USING ERRCODE = 'check_violation';
  END IF;
  -- `restricted` -> `unrestricted` needs an unlock request that was already
  -- recorded on the stored row: a single UPDATE cannot set the request and the
  -- provisioning result together.
  IF OLD.state = 'restricted' AND NEW.state = 'unrestricted' AND OLD.unlock_requested_at IS NULL THEN
    RAISE EXCEPTION 'tenant_access_entitlements: an unlock must be requested before provisioning is recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'unrestricted'
     AND (NEW.provisioned_at IS DISTINCT FROM OLD.provisioned_at
          OR NEW.provisioned_by_user_id IS DISTINCT FROM OLD.provisioned_by_user_id
          OR NEW.provisioning_source IS DISTINCT FROM OLD.provisioning_source) THEN
    RAISE EXCEPTION 'tenant_access_entitlements: the provisioning result is never rewritten'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.unlock_requested_at IS NOT NULL
     AND (NEW.unlock_requested_at IS DISTINCT FROM OLD.unlock_requested_at
          OR NEW.unlock_requested_by_user_id IS DISTINCT FROM OLD.unlock_requested_by_user_id) THEN
    RAISE EXCEPTION 'tenant_access_entitlements: an unlock request is never cleared or rewritten'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER tenant_access_entitlements_guard
  BEFORE UPDATE ON tenant_access_entitlements
  FOR EACH ROW EXECUTE FUNCTION tenant_access_entitlements_guard();

ALTER TABLE tenant_access_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_access_entitlements FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_access_entitlements_tenant_select ON tenant_access_entitlements
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- No tenant self-lift: only a platform admin, inside the target tenant's
-- context, may create or change the row. A row is only ever CREATED as a plain
-- `restricted` one (no unlock request, no provisioning result): the forward
-- path to `unrestricted` is the UPDATE the trigger above guards.
CREATE POLICY tenant_access_entitlements_platform_insert ON tenant_access_entitlements
  FOR INSERT WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    AND state = 'restricted'
    AND unlock_requested_at IS NULL
    AND tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY tenant_access_entitlements_platform_update ON tenant_access_entitlements
  FOR UPDATE
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    AND tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    AND tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
