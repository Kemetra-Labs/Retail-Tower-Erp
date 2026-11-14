-- 0111_system_privilege_policies.sql (RT-1389 Phase 1, owner go-ahead 2026-11-14) — `[GATED: migration]`.
--
-- Three NON-HUMAN paths used to set the human platform-admin flag
-- (`app.is_platform_admin = 'true'`) only to pass row-level security:
--   * public self-signup (request + completion, `signups.service.ts`);
--   * the provisioner bearer verifier's credential lookup (`provisioner-auth.guard.ts`);
--   * the worker provisioning sweep (`erp-provisioning-sweep.ts`).
-- After 0110 that flag also reads EVERY tenant's `tenant_access_entitlements` row, so a
-- future SQL mistake on one of those paths could reach all tenants' access state.
--
-- This migration adds ADDITIVE policies keyed on ONE new setting, `app.system_privilege`,
-- whose value names the path. It is set only by
-- `packages/db/src/middleware/system-privilege.ts` (`runWithSystemPrivilege`), which
-- also forces `app.is_platform_admin = 'false'` in the same transaction. Each value
-- gets only the tables and commands its path already used:
--
--   signup              pending_signups SELECT / INSERT / UPDATE
--                       user_consents   SELECT / INSERT
--                       tenant_access_entitlements INSERT of a clean `restricted` row,
--                         pinned to `app.current_tenant` (the new tenant), the 0105 shape
--   provisioning_sweep  erp_provisioning_request SELECT / UPDATE (cross-tenant, like the pull)
--   provisioner_lookup  erp_provisioner_credential SELECT
--
-- Every other table those paths touch (tenants, roles, memberships, audit_events,
-- connector_health) is reached through the tenant pin, as a tenant session would.
-- `users` and the external identity links have no RLS.
--
-- What does NOT change: no existing policy is altered or dropped; no new policy names
-- `app.is_platform_admin`, and no platform-admin policy names `app.system_privilege`,
-- so none of these sessions reaches a platform-admin policy (the 0110 cross-tenant
-- SELECT among them). No DELETE is granted. The value is compared as text: a missing,
-- empty or differently-cased value matches nothing (no cast, no 22P02).
--
-- No new table, so no grant change: the runtime role already holds these table grants
-- (docs/operations/sql/*-domain-grants.sql).
--
-- Rollback: 0111_system_privilege_policies.down.sql drops exactly these policies. Roll the
-- api and worker back first (the old code uses the platform-admin flag again).

BEGIN;

SET LOCAL lock_timeout = '2s';

DROP POLICY IF EXISTS pending_signups_signup_select ON pending_signups;
DROP POLICY IF EXISTS pending_signups_signup_insert ON pending_signups;
DROP POLICY IF EXISTS pending_signups_signup_update ON pending_signups;
DROP POLICY IF EXISTS user_consents_signup_select ON user_consents;
DROP POLICY IF EXISTS user_consents_signup_insert ON user_consents;
DROP POLICY IF EXISTS tenant_access_entitlements_signup_insert ON tenant_access_entitlements;
DROP POLICY IF EXISTS erp_provisioning_request_sweep_select ON erp_provisioning_request;
DROP POLICY IF EXISTS erp_provisioning_request_sweep_update ON erp_provisioning_request;
DROP POLICY IF EXISTS erp_provisioner_credential_lookup_select ON erp_provisioner_credential;

-- signup ---------------------------------------------------------------------
CREATE POLICY pending_signups_signup_select ON pending_signups
  FOR SELECT USING (current_setting('app.system_privilege', true) = 'signup');

CREATE POLICY pending_signups_signup_insert ON pending_signups
  FOR INSERT WITH CHECK (current_setting('app.system_privilege', true) = 'signup');

CREATE POLICY pending_signups_signup_update ON pending_signups
  FOR UPDATE
  USING (current_setting('app.system_privilege', true) = 'signup')
  WITH CHECK (current_setting('app.system_privilege', true) = 'signup');

CREATE POLICY user_consents_signup_select ON user_consents
  FOR SELECT USING (current_setting('app.system_privilege', true) = 'signup');

CREATE POLICY user_consents_signup_insert ON user_consents
  FOR INSERT WITH CHECK (current_setting('app.system_privilege', true) = 'signup');

-- The one entitlement row a completed signup creates: `restricted`, never unlocked,
-- and only for the tenant the transaction is pinned to (the tenant it just created).
-- No SELECT and no UPDATE: a signup session reads no access state at all.
CREATE POLICY tenant_access_entitlements_signup_insert ON tenant_access_entitlements
  FOR INSERT WITH CHECK (
    current_setting('app.system_privilege', true) = 'signup'
    AND state = 'restricted'
    AND unlock_requested_at IS NULL
    AND tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- provisioning_sweep ---------------------------------------------------------
-- No INSERT: a request is only created by the platform-admin unlock transaction.
-- Status changes are checked by the shared transition table in code and by the 0112
-- trigger in SQL.
CREATE POLICY erp_provisioning_request_sweep_select ON erp_provisioning_request
  FOR SELECT USING (current_setting('app.system_privilege', true) = 'provisioning_sweep');

CREATE POLICY erp_provisioning_request_sweep_update ON erp_provisioning_request
  FOR UPDATE
  USING (current_setting('app.system_privilege', true) = 'provisioning_sweep')
  WITH CHECK (current_setting('app.system_privilege', true) = 'provisioning_sweep');

-- provisioner_lookup ---------------------------------------------------------
-- Read-only: the verifier reads host label + environment of an already-authenticated
-- token. Issue and revoke stay platform-admin.
CREATE POLICY erp_provisioner_credential_lookup_select ON erp_provisioner_credential
  FOR SELECT USING (current_setting('app.system_privilege', true) = 'provisioner_lookup');

COMMIT;
