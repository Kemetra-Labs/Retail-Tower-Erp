-- 0124_catalog_import.down.sql
--
-- RT-1503 (spec 049 S2) -- rollback for 0124_catalog_import.sql.
--
-- Drops the three manual-import tables (with their indexes, triggers,
-- policies and grants) and their functions. Import batches (the lasting
-- summary of every import, with its publish summary and provenance rows) and
-- the tenants' saved mapping profiles would be lost, so the rollback REFUSES
-- while any batch or mapping profile exists (every row needs a batch): back
-- up, decide, and have a superuser remove the rows first. The batches refuse
-- DELETE and TRUNCATE for every role (a trigger), so that superuser must also
-- disable the triggers for the cleanup (ALTER TABLE ... DISABLE TRIGGER USER,
-- or session_replication_role = replica).
--
-- Every table is FORCE ROW LEVEL SECURITY and the production migration owner
-- is not a superuser, so the guard reads under app.is_platform_admin and each
-- tenant's app.current_tenant; a bare SELECT would see no rows and drop them.
-- Both guarded tables are locked ACCESS EXCLUSIVE before the count, so no row
-- can be committed between the guard and the DROPs.
--
-- Rerunnable: once a table is gone there is nothing to guard (to_regclass, and
-- the counts are dynamic statements, never planned against a dropped table);
-- every DROP is IF EXISTS.
--
-- Supports the UP -> DOWN -> UP round trip exercised by
-- packages/db/__tests__/migration/0124-catalog-import.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('catalog_import_batches') IS NULL AND to_regclass('catalog_import_mapping_profiles') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('catalog_import_batches') IS NOT NULL THEN
    LOCK TABLE catalog_import_batches IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('catalog_import_mapping_profiles') IS NOT NULL THEN
    LOCK TABLE catalog_import_mapping_profiles IN ACCESS EXCLUSIVE MODE;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    IF to_regclass('catalog_import_batches') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM catalog_import_batches WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
    IF to_regclass('catalog_import_mapping_profiles') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM catalog_import_mapping_profiles WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0124 down refused: % import batch / mapping profile row(s) exist; import history would be lost', rows_found
      USING HINT = 'Back up the catalog_import_* tables and remove the rows as a superuser first.';
  END IF;
END
$$;

DROP TABLE IF EXISTS catalog_import_rows;
DROP TABLE IF EXISTS catalog_import_batches;
DROP TABLE IF EXISTS catalog_import_mapping_profiles;

DROP FUNCTION IF EXISTS catalog_import_rows_guard();
DROP FUNCTION IF EXISTS catalog_import_batches_no_delete();
DROP FUNCTION IF EXISTS catalog_import_batches_guard();
DROP FUNCTION IF EXISTS catalog_import_mapping_profiles_guard();

COMMIT;
