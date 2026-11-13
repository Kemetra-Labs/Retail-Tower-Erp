-- 0110_tenant_access_entitlements_platform_select.down.sql - reverses
-- 0110_tenant_access_entitlements_platform_select.sql (RT-1350 slice 6a).
--
-- Drops ONLY the platform-wide SELECT policy. The 0105 policies stay. A platform
-- admin then reads a tenant's row only inside that tenant's context again, so
-- roll back the 6a list and the 4b sweep first: without the policy a platform-wide
-- read sees no rows and every tenant would read `unrestricted`. No data is touched.
-- Safe to re-run: IF EXISTS tolerates a missing policy or a missing table.

BEGIN;

DROP POLICY IF EXISTS tenant_access_entitlements_platform_select ON tenant_access_entitlements;

COMMIT;
