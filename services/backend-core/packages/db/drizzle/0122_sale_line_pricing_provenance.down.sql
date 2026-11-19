-- 0122_sale_line_pricing_provenance.down.sql
--
-- RT-1151 (RT-282 PR-07) -- rollback for 0122_sale_line_pricing_provenance.sql.
--
-- Drops sale_line_pricing_provenance (with its index, triggers, policies and
-- grants) and its function. The rows are frozen sale facts, so the rollback
-- REFUSES while any row exists: back up, decide, and have a superuser remove
-- them first, with the append-only triggers disabled (ALTER TABLE ... DISABLE
-- TRIGGER USER, or session_replication_role = replica).
--
-- The table is FORCE ROW LEVEL SECURITY and the production migration owner is
-- not a superuser, so the guard reads under app.is_platform_admin and each
-- tenant's app.current_tenant; a bare SELECT would see no rows and drop them.
-- The table is locked ACCESS EXCLUSIVE before the count, so no row can be
-- committed between the guard and the DROP.
--
-- Rerunnable: once the table is gone there is nothing to guard (to_regclass,
-- and the count is a dynamic statement); every DROP is IF EXISTS.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('sale_line_pricing_provenance') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE sale_line_pricing_provenance IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM sale_line_pricing_provenance WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0122 down refused: % sale-line pricing provenance row(s) exist; sale facts would be lost', rows_found
      USING HINT = 'Back up the table and remove the rows as a superuser first.';
  END IF;
END
$$;

DROP TABLE IF EXISTS sale_line_pricing_provenance;
DROP FUNCTION IF EXISTS sale_line_pricing_provenance_append_only();

COMMIT;
