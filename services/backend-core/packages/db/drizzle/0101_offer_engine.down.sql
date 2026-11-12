-- 0101_offer_engine.down.sql
--
-- RT-1336 (RT-286 S3) -- rollback for 0101_offer_engine.sql.
--
-- Drops the ten Offer Engine tables (with their indexes, triggers, policies
-- and grants), their functions, and the tenant_product_categories (id,
-- tenant_id) key. Offers, versions, Pack revisions and the frozen sale
-- promotion facts would be lost, so the rollback REFUSES while any offer or
-- Pack revision exists (every other table needs one of the two): back up,
-- decide, and have a superuser remove the rows first. The facts are
-- append-only for every role (a trigger refuses DELETE and TRUNCATE), so that
-- superuser must also disable the triggers for the cleanup (ALTER TABLE ...
-- DISABLE TRIGGER USER, or session_replication_role = replica).
--
-- Every table is FORCE ROW LEVEL SECURITY and the production migration owner
-- is not a superuser, so the guard reads under app.is_platform_admin and each
-- tenant's app.current_tenant; a bare SELECT would see no rows and drop them.
-- Both guarded tables are locked ACCESS EXCLUSIVE before the count, so no row
-- can be committed between the guard and the DROPs.
--
-- Rerunnable: once a table is gone there is nothing to guard (to_regclass,
-- and the counts are dynamic statements, never planned against a dropped
-- table); every DROP is IF EXISTS.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0101-offer-engine.spec.ts and the full-chain
-- down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('offers') IS NULL AND to_regclass('offer_pack_revisions') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('offers') IS NOT NULL THEN
    LOCK TABLE offers IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('offer_pack_revisions') IS NOT NULL THEN
    LOCK TABLE offer_pack_revisions IN ACCESS EXCLUSIVE MODE;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    IF to_regclass('offers') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM offers WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
    IF to_regclass('offer_pack_revisions') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM offer_pack_revisions WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0101 down refused: % offer(s) or Offer Pack revision(s) exist; the Offer Engine facts are append-only, so a superuser must remove the rows (after a backup, with the triggers disabled) before rollback', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS sale_return_promotion_clawbacks;
DROP TABLE IF EXISTS sale_line_promotions;
DROP TABLE IF EXISTS offer_pack_eligible_products;
DROP TABLE IF EXISTS offer_pack_store_revisions;
DROP TABLE IF EXISTS offer_pack_revisions;
DROP TABLE IF EXISTS offer_pauses;
DROP TABLE IF EXISTS offer_version_rules;
DROP TABLE IF EXISTS offer_version_stores;
DROP TABLE IF EXISTS offer_versions;
DROP TABLE IF EXISTS offers;

DROP FUNCTION IF EXISTS sale_line_promotions_line_guard();
DROP FUNCTION IF EXISTS offer_pack_eligible_products_guard();
DROP FUNCTION IF EXISTS offer_pack_store_revisions_guard();
DROP FUNCTION IF EXISTS offer_pack_revisions_before_insert();
DROP FUNCTION IF EXISTS offer_pauses_guard();
DROP FUNCTION IF EXISTS offer_versions_complete();
DROP FUNCTION IF EXISTS offer_version_children_guard();
DROP FUNCTION IF EXISTS offer_versions_before_insert();
DROP FUNCTION IF EXISTS offers_guard();
DROP FUNCTION IF EXISTS offer_engine_append_only();

DROP INDEX IF EXISTS uq_tenant_product_categories_id_tenant;

COMMIT;
