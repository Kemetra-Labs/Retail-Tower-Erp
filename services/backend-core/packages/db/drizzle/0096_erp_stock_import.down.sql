-- 0096_erp_stock_import.down.sql
--
-- RT-1288 — rollback for 0096_erp_stock_import.sql.
--
-- Drops the four import tables (with their indexes, policies and grants) and
-- restores the original `inventory_effect_integration_confirmed_at` CHECK
-- (only `confirmed` carries erp_confirmed_at).
--
-- REFUSES while any import run exists: the run, page and row records are the
-- audit of the `erp_external` effects already written, and those effects'
-- `external` integration records carry erp_confirmed_at, which the original
-- CHECK forbids. Back up, decide, and delete them explicitly first. The tables
-- are FORCE ROW LEVEL SECURITY and the production migration owner is not a
-- superuser, so the guard reads under app.is_platform_admin and each tenant's
-- app.current_tenant (the 0087 pattern).
--
-- The runs table is locked ACCESS EXCLUSIVE before the count, so no run can be
-- opened between the guard and the DROP. Rerunnable: once the tables are gone
-- there is nothing to guard.
--
-- Supports the UP -> DOWN -> UP round trip exercised by
-- packages/db/__tests__/migration/0096-erp-stock-import.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  runs_found bigint := 0;
BEGIN
  IF to_regclass('erp_stock_import_runs') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE erp_stock_import_runs IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM erp_stock_import_runs WHERE tenant_id = $1' INTO n USING t;
    runs_found := runs_found + n;
  END LOOP;
  IF runs_found > 0 THEN
    RAISE EXCEPTION '0096 down refused: % ERP stock import run(s) exist; back up and delete the import records and their erp_external effects explicitly first', runs_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS erp_stock_import_findings;
DROP TABLE IF EXISTS erp_stock_import_rows;
DROP TABLE IF EXISTS erp_stock_import_pages;
DROP TABLE IF EXISTS erp_stock_import_runs;

ALTER TABLE inventory_effect_integration
  DROP CONSTRAINT IF EXISTS inventory_effect_integration_confirmed_at;
ALTER TABLE inventory_effect_integration
  ADD CONSTRAINT inventory_effect_integration_confirmed_at
    CHECK ((state = 'confirmed') = (erp_confirmed_at IS NOT NULL)) NOT VALID;
ALTER TABLE inventory_effect_integration
  VALIDATE CONSTRAINT inventory_effect_integration_confirmed_at;

COMMIT;
