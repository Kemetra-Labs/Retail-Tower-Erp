-- 0119_shift_forced_close_console_origin.down.sql
--
-- Rollback for 0119_shift_forced_close_console_origin.sql (RT-1445). Drops the
-- two CHECKs and `closed_via`, and makes `closed_from_device_id` NOT NULL again.
--
-- A Console close is evidence with NO closing terminal: it cannot be made NOT
-- NULL without inventing a device, and dropping `closed_via` would erase that it
-- came from the Console. So the rollback REFUSES while any Console close is
-- recorded: back up, decide, and delete them explicitly first (the table is
-- append-only, so that is a deliberate break-glass step). The table is FORCE
-- ROW LEVEL SECURITY and the production migration owner is not a superuser
-- (docs/operations/database-roles.md), so the guard reads under each tenant's
-- app.current_tenant (the 0051 / 0054 / 0070 pattern); a bare SELECT would see
-- no rows and proceed. Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0119-shift-forced-close-console-origin.spec.ts.

BEGIN;

DO $$
DECLARE
  t uuid;
  rows_found bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    rows_found := rows_found + (
      SELECT count(*) FROM shift_forced_closes WHERE tenant_id = t AND closed_via = 'console');
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0119 down refused: % Console force close(s) recorded; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

ALTER TABLE shift_forced_closes DROP CONSTRAINT IF EXISTS shift_forced_closes_closed_via_device;
ALTER TABLE shift_forced_closes DROP CONSTRAINT IF EXISTS shift_forced_closes_closed_via_values;
ALTER TABLE shift_forced_closes DROP COLUMN IF EXISTS closed_via;
ALTER TABLE shift_forced_closes ALTER COLUMN closed_from_device_id SET NOT NULL;

COMMIT;
