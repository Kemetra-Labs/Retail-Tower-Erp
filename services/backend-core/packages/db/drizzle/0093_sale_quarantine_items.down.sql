-- 0093_sale_quarantine_items.down.sql
--
-- RT-1312 Phase 3(b) -- rollback for 0093_sale_quarantine_items.sql.
--
-- Drops `sale_quarantine_items` (with its index, trigger and policies). A
-- quarantine item is a paid sale the till could not get captured, often the
-- only record of it, so the rollback REFUSES while any item exists: back up,
-- decide, and have a superuser remove the rows first (the table has no DELETE
-- policy, so the migration owner cannot). The table is FORCE ROW LEVEL
-- SECURITY and the production migration owner is not a superuser, so the guard
-- reads under app.is_platform_admin and each tenant's app.current_tenant; a
-- bare SELECT would see no rows and drop them.
--
-- The table is locked ACCESS EXCLUSIVE before the count, so no row can be
-- committed between the guard and the DROP.
--
-- Rerunnable: once the table is gone there is nothing to guard (to_regclass,
-- and the count is a dynamic statement, so it is never planned against a
-- dropped table).
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0093-sale-quarantine-items.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('sale_quarantine_items') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE sale_quarantine_items IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM sale_quarantine_items WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0093 down refused: % sale quarantine item(s) exist; the table has no DELETE policy, so a superuser must remove the rows (after a backup, under the data-retention procedure) before rollback', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS sale_quarantine_items;

COMMIT;
