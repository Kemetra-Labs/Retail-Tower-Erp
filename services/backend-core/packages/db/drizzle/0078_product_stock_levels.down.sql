-- 0078_product_stock_levels.down.sql
--
-- Rollback for 0078_product_stock_levels.sql (RT-1066). Drops the
-- product_stock_levels table (its indexes, trigger and policies go with it).
--
-- A stored level is operator configuration: dropping the table would silently
-- LOSE every configured threshold (and its retired history). So the rollback
-- REFUSES while any row, active or retired, is stored (the 044 R3 pattern):
-- back up, decide, and delete them explicitly first. The table is FORCE ROW
-- LEVEL SECURITY and the production migration owner is not a superuser
-- (docs/operations/database-roles.md), so the guard counts under each
-- tenant's app.current_tenant (the 0070 pattern); a bare SELECT would see no
-- rows and drop them. Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0078-product-stock-levels.spec.ts.

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
    rows_found := rows_found + (SELECT count(*) FROM product_stock_levels WHERE tenant_id = t);
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0078 down refused: % stock level(s) stored; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS product_stock_levels;

COMMIT;
