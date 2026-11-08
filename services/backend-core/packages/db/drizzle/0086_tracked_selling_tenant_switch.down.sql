-- 0086_tracked_selling_tenant_switch.down.sql
--
-- RT-451 S2 — rollback for 0086_tracked_selling_tenant_switch.sql.
--
-- Drops ONLY the three columns this migration added to
-- `tenant_inventory_settings` and their two CHECK constraints. IT DISCARDS
-- DATA: every tenant's tracked-selling switch state, so every tenant reads OFF
-- again. No other column, policy, constraint, row or audit record is touched.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0086-tracked-selling-tenant-switch.spec.ts and
-- the full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_tracked_selling_on_changed,
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_tracked_selling_change_pair;

ALTER TABLE tenant_inventory_settings
  DROP COLUMN IF EXISTS tracked_selling_changed_by,
  DROP COLUMN IF EXISTS tracked_selling_changed_at,
  DROP COLUMN IF EXISTS tracked_selling_enabled;

COMMIT;
