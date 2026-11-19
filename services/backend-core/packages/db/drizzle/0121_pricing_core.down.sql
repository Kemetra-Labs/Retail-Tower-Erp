-- 0121_pricing_core.down.sql
--
-- RT-1151 (RT-282 PR-05) -- rollback for 0121_pricing_core.sql.
--
-- Drops the seven Retail Pricing tables (with their indexes, triggers,
-- policies and grants) and their functions. Price Books, Change Sets,
-- revisions and the price timeline would be lost, so the rollback REFUSES while
-- any Change Set or Price Book exists (spec 044 R3; every other table needs one
-- of the two): back up, decide, and have a superuser remove the rows first.
-- Revisions and fan-out rows are append-only and every other pricing row
-- refuses DELETE for every role (a trigger), so that superuser must also
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
-- packages/db/__tests__/migration/0121-pricing-core.spec.ts and the full-chain
-- down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('change_sets') IS NULL AND to_regclass('price_books') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('change_sets') IS NOT NULL THEN
    LOCK TABLE change_sets IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('price_books') IS NOT NULL THEN
    LOCK TABLE price_books IN ACCESS EXCLUSIVE MODE;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    IF to_regclass('change_sets') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM change_sets WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
    IF to_regclass('price_books') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM price_books WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0121 down refused: % Change Set / Price Book row(s) exist; pricing data would be lost', rows_found
      USING HINT = 'Back up the pricing tables and remove the rows as a superuser first (spec 044 R3).';
  END IF;
END
$$;

DROP TABLE IF EXISTS price_events;
DROP TABLE IF EXISTS price_zone_memberships;
DROP TABLE IF EXISTS pricing_revision_stores;
-- change_sets.revision_no references pricing_revisions, and pricing_revisions
-- references change_sets: drop the cycle's edge first.
ALTER TABLE IF EXISTS change_sets DROP CONSTRAINT IF EXISTS change_sets_revision_fk;
DROP TABLE IF EXISTS pricing_revisions;
DROP TABLE IF EXISTS price_zones;
DROP TABLE IF EXISTS price_books;
DROP TABLE IF EXISTS change_sets;

DROP FUNCTION IF EXISTS pricing_timeline_guard();
DROP FUNCTION IF EXISTS pricing_timeline_before_insert();
DROP FUNCTION IF EXISTS pricing_revision_stores_before_insert();
DROP FUNCTION IF EXISTS pricing_revision_issued_here(uuid, bigint);
DROP FUNCTION IF EXISTS pricing_revisions_before_insert();
DROP FUNCTION IF EXISTS price_books_has_default_zone();
DROP FUNCTION IF EXISTS price_zones_guard();
DROP FUNCTION IF EXISTS price_books_guard();
DROP FUNCTION IF EXISTS change_sets_guard();
DROP FUNCTION IF EXISTS pricing_no_delete();
DROP FUNCTION IF EXISTS pricing_append_only();

COMMIT;
