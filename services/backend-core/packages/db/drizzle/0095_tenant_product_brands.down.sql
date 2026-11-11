-- 0095_tenant_product_brands.down.sql
--
-- RT-1334 (RT-286 S1) -- rollback for 0095_tenant_product_brands.sql.
--
-- Drops `tenant_products.brand_id` (with its FK and index), then
-- `tenant_product_brands` (with its indexes, trigger, policies and grants). A
-- brand is catalog master data and every product's brand would be lost, so
-- the rollback REFUSES while any brand exists: back up, decide, and have a
-- superuser remove the rows first (the table has no DELETE policy, so the
-- migration owner cannot). The table is FORCE ROW LEVEL SECURITY and the
-- production migration owner is not a superuser, so the guard reads under
-- app.is_platform_admin and each tenant's app.current_tenant; a bare SELECT
-- would see no rows and drop them. A product cannot hold a brand_id without a
-- brand row (composite FK), so counting brands covers both.
--
-- Both tables are locked ACCESS EXCLUSIVE before the count (tenant_products
-- first, the order of the up), so no brand can be committed between the guard
-- and the DROPs.
--
-- Rerunnable: once the table is gone there is nothing to guard (to_regclass,
-- and the count is a dynamic statement, so it is never planned against a
-- dropped table); every DROP is IF EXISTS.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0095-tenant-product-brands.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('tenant_product_brands') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE tenant_products IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE tenant_product_brands IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM tenant_product_brands WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0095 down refused: % brand(s) exist; the table has no DELETE policy, so a superuser must remove the rows (after a backup) before rollback', rows_found;
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_tenant_products_tenant_brand;
ALTER TABLE tenant_products DROP CONSTRAINT IF EXISTS fk_tenant_products_brand_tenant;
ALTER TABLE tenant_products DROP COLUMN IF EXISTS brand_id;
DROP TABLE IF EXISTS tenant_product_brands;

COMMIT;
