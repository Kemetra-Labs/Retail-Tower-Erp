-- 0086_tracked_selling_tenant_switch.down.sql
--
-- RT-451 S2 — rollback for 0086_tracked_selling_tenant_switch.sql.
--
-- Drops ONLY the three columns this migration added to
-- `tenant_inventory_settings` and their two CHECK constraints. No other
-- column, policy, constraint, row or audit record is touched.
--
-- A switched-on tenant would silently read OFF after a down, against OD-T7
-- (the switch never turns itself off; only an owner or tenant_admin switches
-- it off), so the rollback REFUSES while any tenant has tracked selling
-- switched on: switch it off through `setTrackedSellingSetting` first (audited),
-- as 0056 / 0063 / 0072 refuse while their settings hold non-default state.
-- A switched-off tenant's change time and actor are discarded; the audit
-- trail keeps the history. The table is FORCE ROW LEVEL SECURITY and the
-- production migration owner is not a superuser, so the guard reads under
-- app.is_platform_admin and each tenant's app.current_tenant (the 0072
-- pattern); a bare SELECT would see no rows.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0086-tracked-selling-tenant-switch.spec.ts and
-- the full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DO $$
DECLARE
  t uuid;
  switched_on bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    switched_on := switched_on
      + (SELECT count(*) FROM tenant_inventory_settings
          WHERE tenant_id = t AND tracked_selling_enabled);
  END LOOP;
  IF switched_on > 0 THEN
    RAISE EXCEPTION '0086 down refused: % tenant(s) have tracked selling switched on; switch it off first', switched_on;
  END IF;
END
$$;

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_tracked_selling_on_changed,
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_tracked_selling_change_pair;

ALTER TABLE tenant_inventory_settings
  DROP COLUMN IF EXISTS tracked_selling_changed_by,
  DROP COLUMN IF EXISTS tracked_selling_changed_at,
  DROP COLUMN IF EXISTS tracked_selling_enabled;

COMMIT;
