-- 0110_tenant_access_entitlements_platform_select.sql (RT-1350 slice 6a, owner delegation 2026-11-13)
--
-- Adds ONE additive SELECT policy to `tenant_access_entitlements` (0105): a platform
-- admin reads every tenant's row WITHOUT a tenant pin.
--
-- Why. The 0105 SELECT policy is pinned to `app.current_tenant`, so no cross-tenant
-- read of the table is possible. Two platform-scope readers need one (RT-1350):
--   * 6a: the platform tenant list (`listTenants`) shows each tenant's access state
--     with a LEFT JOIN in SQL (no row = `unrestricted`, the RT-1353 rule) and filters
--     by it;
--   * 4b: the daily sweep selects restricted, never-unlocked tenants in ONE query.
-- Without this policy a platform-wide read sees 0 rows, so every tenant would read
-- `unrestricted`: the list would be wrong and the sweep would never find a candidate.
--
-- Why a platform-wide read is safe. `app.is_platform_admin = 'true'` is set only by the
-- server for a platform admin session (the same flag that already lets a platform admin
-- list every tenant, `GET /api/v1/tenants`, and read every tenant's state one by one via
-- the 0105 routes). The row holds an access state and unlock timestamps, no secret and
-- no PII beyond two user ids. Nothing else changes: the tenant SELECT, INSERT and UPDATE
-- policies, the guard trigger and the grants stay as they are; there is still no DELETE
-- policy. A platform admin still WRITES only inside the target tenant's context.
--
-- A missing or empty GUC compares as not 'true' (no uuid cast, so no 22P02): a session
-- with no tenant and no platform flag still reads nothing.
--
-- Rollback: 0110_tenant_access_entitlements_platform_select.down.sql.

BEGIN;

SET LOCAL lock_timeout = '2s';

DROP POLICY IF EXISTS tenant_access_entitlements_platform_select ON tenant_access_entitlements;

CREATE POLICY tenant_access_entitlements_platform_select ON tenant_access_entitlements
  FOR SELECT USING (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;
