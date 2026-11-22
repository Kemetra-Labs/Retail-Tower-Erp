-- 0132_pricing_authority_freeze.down.sql
--
-- RT-1485 (spec 044 PR-16a-1) -- rollback for 0132_pricing_authority_freeze.sql.
--
-- Drops the legacy price freeze triggers, the tenants seed trigger, the four functions and the
-- three tables, and revokes what 0132 granted pricing_projection_writer on the legacy tables.
--
-- Spec 044 §8.2 R3: the rollback REFUSES while any tenant_pricing_authority row is not `legacy`
-- (a tenant would silently lose its freeze and its authority) or while pricing_import_runs or
-- pricing_cutover_runs hold any row (evidence would be lost). The seeded all-`legacy` rows alone
-- do not block it: they are rebuilt by the next up. Down never drops data a later step needs.
--
-- Every table is FORCE ROW LEVEL SECURITY and the production migration owner is not a superuser,
-- so the guard reads under each tenant's app.current_tenant (listed as platform admin, with the
-- GUC pinned to the nil UUID first: the tenants policy casts it without the empty-GUC guard); a
-- bare SELECT would see no rows and drop them. The three tables are locked ACCESS EXCLUSIVE
-- before the count, so no row can be committed between the guard and the DROPs.
--
-- The role pricing_projection_writer is NOT dropped: the migration owner is NOCREATEROLE and could
-- neither drop nor re-create it. It owns nothing after this file and holds no table privilege;
-- the next up reuses it.
--
-- Rerunnable: once a table is gone there is nothing to guard (to_regclass, and the counts are
-- dynamic statements, never planned against a dropped table); every DROP is IF EXISTS.
--
-- Supports the UP -> DOWN -> UP round trip exercised by
-- packages/db/__tests__/migration/0132-pricing-authority-freeze.spec.ts and the full-chain down in
-- packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('tenant_pricing_authority') IS NULL
     AND to_regclass('pricing_import_runs') IS NULL
     AND to_regclass('pricing_cutover_runs') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('tenant_pricing_authority') IS NOT NULL THEN
    LOCK TABLE tenant_pricing_authority IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('pricing_import_runs') IS NOT NULL THEN
    LOCK TABLE pricing_import_runs IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('pricing_cutover_runs') IS NOT NULL THEN
    LOCK TABLE pricing_cutover_runs IN ACCESS EXCLUSIVE MODE;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    IF to_regclass('tenant_pricing_authority') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM tenant_pricing_authority WHERE tenant_id = $1 AND authority <> ''legacy'''
        INTO n USING t;
      rows_found := rows_found + n;
    END IF;
    IF to_regclass('pricing_import_runs') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM pricing_import_runs WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
    IF to_regclass('pricing_cutover_runs') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM pricing_cutover_runs WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
  END LOOP;
  PERFORM set_config('app.is_platform_admin', '', true);
  PERFORM set_config('app.current_tenant', '', true);
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0132 down refused: % non-legacy authority row(s) or pricing run row(s) exist', rows_found
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Roll every tenant back to legacy (R1) and back up the run rows; a superuser then removes them '
                || '(with the run tables'' triggers disabled: ALTER TABLE ... DISABLE TRIGGER USER) (spec 044 §8.2 R3).';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS tenant_products_pricing_freeze ON tenant_products;
DROP TRIGGER IF EXISTS store_product_overrides_pricing_freeze ON store_product_overrides;
DROP TRIGGER IF EXISTS tenants_pricing_authority_seed ON tenants;

DROP FUNCTION IF EXISTS pricing_legacy_freeze();
DROP FUNCTION IF EXISTS pricing_authority_seed_tenant();
DROP FUNCTION IF EXISTS pricing_authority_for_share(uuid);
DROP FUNCTION IF EXISTS pricing_reverse_project(uuid, uuid, uuid, numeric, char, uuid, uuid);

DROP TABLE IF EXISTS tenant_pricing_authority;
DROP TABLE IF EXISTS pricing_import_runs;
DROP TABLE IF EXISTS pricing_cutover_runs;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pricing_projection_writer') THEN
    REVOKE ALL ON tenant_products FROM pricing_projection_writer;
    REVOKE ALL ON store_product_overrides FROM pricing_projection_writer;
    REVOKE ALL ON catalog_change_log FROM pricing_projection_writer;
  END IF;
END
$$;

COMMIT;
