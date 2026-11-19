-- 0123_price_change_set_items_lines.down.sql
--
-- RT-1151 (RT-282 PR-05) -- rollback for 0123_price_change_set_items_lines.sql.
--
-- Drops the six Price Change Set content tables (item lists, items,
-- validations, lines, preview lines, preview membership changes; with their
-- indexes, triggers and policies), their functions, and change_sets'
-- created-as-draft, content-rules and publish-complete triggers, its
-- one-legacy-import index, and pricing_revisions' published trigger. A Change Set's authored items, its validations with
-- the stored Impact Preview, and its lines (a published set's per-line
-- before/after record, spec 042 §10) would be lost, so the rollback REFUSES
-- while any item list or validation exists (every other content row hangs off
-- one): back up, decide, and have a superuser remove the rows first, with the
-- append-only triggers disabled (ALTER TABLE ... DISABLE TRIGGER USER, or
-- session_replication_role = replica).
--
-- Every table is FORCE ROW LEVEL SECURITY and the production migration owner
-- is not a superuser, so the guard reads under app.is_platform_admin and each
-- tenant's app.current_tenant; a bare SELECT would see no rows and drop them.
-- change_sets and every content table are locked before the count (content
-- ACCESS EXCLUSIVE, change_sets too, as DROP TRIGGER needs), so no row can be committed between the
-- guard and the DROPs.
--
-- Rerunnable: once the tables are gone there is nothing to guard
-- (to_regclass; the counts are dynamic statements); every DROP is IF EXISTS.
--
-- Supports the UP -> DOWN -> UP round trip exercised by
-- packages/db/__tests__/migration/0123-price-change-set-items-lines.spec.ts and
-- the full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
  tbl text;
BEGIN
  IF to_regclass('price_change_set_item_lists') IS NULL AND to_regclass('price_change_set_validations') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('change_sets') IS NOT NULL THEN
    LOCK TABLE change_sets IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('pricing_revisions') IS NOT NULL THEN
    LOCK TABLE pricing_revisions IN ACCESS EXCLUSIVE MODE;
  END IF;
  FOREACH tbl IN ARRAY ARRAY['price_change_set_preview_memberships', 'price_change_set_preview_lines',
                             'price_change_set_lines', 'price_change_set_validations',
                             'price_change_set_items', 'price_change_set_item_lists'] LOOP
    IF to_regclass(tbl) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', tbl);
    END IF;
  END LOOP;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    FOREACH tbl IN ARRAY ARRAY['price_change_set_item_lists', 'price_change_set_validations'] LOOP
      IF to_regclass(tbl) IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', tbl) INTO n USING t;
        rows_found := rows_found + n;
      END IF;
    END LOOP;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0123 down refused: % Change Set item list / validation row(s) exist; Change Set content would be lost', rows_found
      USING HINT = 'Back up the Change Set content tables and remove the rows as a superuser first (spec 044 R3).';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS change_sets_content_rules ON change_sets;
DROP TRIGGER IF EXISTS change_sets_publish_complete ON change_sets;
DROP TRIGGER IF EXISTS change_sets_created_as_draft ON change_sets;
DROP TRIGGER IF EXISTS pricing_revisions_published ON pricing_revisions;
DROP INDEX IF EXISTS ux_change_sets_one_legacy_import;
DROP TABLE IF EXISTS price_change_set_preview_memberships;
DROP TABLE IF EXISTS price_change_set_preview_lines;
DROP TABLE IF EXISTS price_change_set_lines;
DROP TABLE IF EXISTS price_change_set_validations;
DROP TABLE IF EXISTS price_change_set_items;
DROP TABLE IF EXISTS price_change_set_item_lists;

DROP FUNCTION IF EXISTS pricing_revisions_published();
DROP FUNCTION IF EXISTS change_sets_publish_complete();
DROP FUNCTION IF EXISTS price_change_set_publish_record_check(uuid, uuid, integer, bigint);
DROP FUNCTION IF EXISTS change_sets_assert_legacy_import(uuid);
DROP FUNCTION IF EXISTS price_change_set_assert_tenant(uuid);
DROP FUNCTION IF EXISTS change_sets_created_as_draft();
DROP FUNCTION IF EXISTS change_sets_content_rules();
DROP FUNCTION IF EXISTS price_change_set_preview_before_insert();
DROP FUNCTION IF EXISTS price_change_set_lines_guard();
DROP FUNCTION IF EXISTS price_change_set_lines_before_insert();
DROP FUNCTION IF EXISTS price_change_set_validation_sealed(uuid, uuid, integer);
DROP FUNCTION IF EXISTS price_change_set_validations_complete();
DROP FUNCTION IF EXISTS price_change_set_validations_before_insert();
DROP FUNCTION IF EXISTS price_change_set_items_before_insert();
DROP FUNCTION IF EXISTS price_change_set_item_lists_complete();
DROP FUNCTION IF EXISTS price_change_set_item_lists_before_insert();
DROP FUNCTION IF EXISTS price_change_set_content_append_only();

COMMIT;
