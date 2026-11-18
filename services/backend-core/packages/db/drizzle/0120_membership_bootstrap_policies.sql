-- 0120_membership_bootstrap_policies.sql (RT-1457 / audit A-04, RT-1389 phase 2) — `[GATED: migration]`.
--
-- The request bootstrap reads (`RolesGuard`, `TenantContextGuard`, `ContextService`, the sign-in
-- membership list and the POS stuck-shift membership lookup) run on every authenticated request.
-- Today they set the human platform-admin flag (`app.is_platform_admin = 'true'`) only to pass
-- row-level security, so one missing predicate in a bootstrap query reads across tenants with the
-- platform-admin power (which after 0110 also reads every tenant's access state).
--
-- This migration adds ADDITIVE, SELECT-ONLY policies keyed on ONE more value of the RT-1389
-- setting `app.system_privilege`: `membership_bootstrap`. It is set only by
-- `packages/db/src/middleware/system-privilege.ts` (`runWithSystemPrivilege`), which also forces
-- `app.is_platform_admin = 'false'` in the same transaction. The tables are exactly the ones the
-- bootstrap queries read (listed from the code, RT-1457):
--
--   memberships   findActiveMembership, hasLiveMembership, findRoleCodeForUserInTenant,
--                 activeMembershipRows (listForUser, listTenantRolesForUser), the POS lookup
--   roles         findRoleCodeForUserInTenant, activeMembershipRows, the POS lookup
--   tenants       isTenantActive, findTenantSummary, tenantIsActive() joins
--   stores        canAccessStore, findStoreSummary, listGrantedStoreIds, the POS lookup
--   store_access  canAccessStore, listGrantedStoreIds, listForUser, the POS lookup
--
-- `users` has no RLS. No other table is read by these paths (the support-session gate keeps its own
-- platform-admin context and is not part of this change).
--
-- What does NOT change: no existing policy is altered or dropped; the platform-admin and tenant
-- policies stay, so the old flag keeps working until the callers move (additive). No new policy
-- names `app.is_platform_admin`, and no platform-admin policy names `app.system_privilege`. There is
-- NO INSERT, UPDATE or DELETE policy: a `membership_bootstrap` session cannot write anything. The
-- value is compared as text: a missing, empty or differently-cased value matches nothing (no cast,
-- no 22P02).
--
-- No new table, so no grant change: the runtime role already holds these table grants.
--
-- Rollback: 0120_membership_bootstrap_policies.down.sql drops exactly these five policies. Roll the
-- api back first (the new code reads on `app.system_privilege = 'membership_bootstrap'`).

BEGIN;

SET LOCAL lock_timeout = '2s';

DROP POLICY IF EXISTS memberships_membership_bootstrap_select ON memberships;
DROP POLICY IF EXISTS roles_membership_bootstrap_select ON roles;
DROP POLICY IF EXISTS tenants_membership_bootstrap_select ON tenants;
DROP POLICY IF EXISTS stores_membership_bootstrap_select ON stores;
DROP POLICY IF EXISTS store_access_membership_bootstrap_select ON store_access;

CREATE POLICY memberships_membership_bootstrap_select ON memberships
  FOR SELECT USING (current_setting('app.system_privilege', true) = 'membership_bootstrap');

CREATE POLICY roles_membership_bootstrap_select ON roles
  FOR SELECT USING (current_setting('app.system_privilege', true) = 'membership_bootstrap');

CREATE POLICY tenants_membership_bootstrap_select ON tenants
  FOR SELECT USING (current_setting('app.system_privilege', true) = 'membership_bootstrap');

CREATE POLICY stores_membership_bootstrap_select ON stores
  FOR SELECT USING (current_setting('app.system_privilege', true) = 'membership_bootstrap');

CREATE POLICY store_access_membership_bootstrap_select ON store_access
  FOR SELECT USING (current_setting('app.system_privilege', true) = 'membership_bootstrap');

COMMIT;
