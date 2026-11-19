-- 0123_price_change_set_items_lines.down.sql
--
-- RT-1151 (RT-282 PR-05) -- rollback for 0123_price_change_set_items_lines.sql.
--
-- Drops price_change_set_lines and price_change_set_items (with their
-- indexes, triggers and policies) and their functions. A Change Set's authored
-- items and its materialized lines (the per-line before/after record of a
-- published set, spec 042 §10) would be lost, so the rollback REFUSES while
-- any item or line exists: back up, decide, and have a
-- superuser remove the rows first, with the append-only triggers disabled
-- (ALTER TABLE ... DISABLE TRIGGER USER, or session_replication_role = replica).
--
-- Both tables are FORCE ROW LEVEL SECURITY and the production migration owner
-- is not a superuser, so the guard reads under app.is_platform_admin and each
-- tenant's app.current_tenant; a bare SELECT would see no rows and drop them.
-- Both tables are locked ACCESS EXCLUSIVE before the count, so no row can be
-- committed between the guard and the DROPs.
--
-- Rerunnable: once the items table is gone there is nothing to guard
-- (to_regclass; the count is a dynamic statement); every DROP is IF EXISTS.
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
BEGIN
  IF to_regclass('price_change_set_items') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('price_change_set_lines') IS NOT NULL THEN
    LOCK TABLE price_change_set_lines IN ACCESS EXCLUSIVE MODE;
  END IF;
  LOCK TABLE price_change_set_items IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM price_change_set_items WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
    IF to_regclass('price_change_set_lines') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM price_change_set_lines WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0123 down refused: % Change Set item / line row(s) exist; Change Set content would be lost', rows_found
      USING HINT = 'Back up the Change Set content tables and remove the rows as a superuser first (spec 044 R3).';
  END IF;
END
$$;

DROP TABLE IF EXISTS price_change_set_lines;
DROP TABLE IF EXISTS price_change_set_items;

DROP TRIGGER IF EXISTS change_sets_redraft_bumps_version ON change_sets;
DROP FUNCTION IF EXISTS change_sets_redraft_bumps_version();
DROP FUNCTION IF EXISTS price_change_set_lines_guard();
DROP FUNCTION IF EXISTS price_change_set_lines_before_insert();
DROP FUNCTION IF EXISTS price_change_set_items_before_insert();
DROP FUNCTION IF EXISTS price_change_set_content_append_only();

COMMIT;
