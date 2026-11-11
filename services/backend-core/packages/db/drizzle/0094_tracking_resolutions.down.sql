-- 0094_tracking_resolutions.down.sql
--
-- RT-451 S5 — rollback for 0094_tracking_resolutions.sql.
--
-- Drops ONLY `tracking_resolution_lines` and `tracking_resolutions` (with
-- their indexes, policies and grants). Every resolution is the audited record
-- of a bind that moved stock and emitted an ERP intent, and the sale effect
-- writers read its lines, so the rollback REFUSES while any resolution exists:
-- back up, decide, and delete them explicitly first (the 0072 / 0087
-- pattern). Both tables are FORCE ROW LEVEL SECURITY and the production
-- migration owner is not a superuser, so the guard reads under
-- app.is_platform_admin and each tenant's app.current_tenant; a bare SELECT
-- would see no rows and drop them.
--
-- Both tables are locked ACCESS EXCLUSIVE before the count, so no resolution
-- can be committed between the guard and the DROP. A bound sale's
-- `sales.tracking_status` is 'tracked'; with no resolution left there is none.
--
-- Rerunnable: once the tables are gone there is nothing to guard. They are
-- resolved through the search path with to_regclass, as the DROPs below
-- resolve them, and the count is a dynamic statement, so the guard is never
-- planned against a dropped table.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0094-tracking-resolutions.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('tracking_resolutions') IS NULL THEN
    RETURN;
  END IF;
  -- Lines first, then resolutions: the order the bind writes them.
  IF to_regclass('tracking_resolution_lines') IS NOT NULL THEN
    LOCK TABLE tracking_resolution_lines IN ACCESS EXCLUSIVE MODE;
  END IF;
  LOCK TABLE tracking_resolutions IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM tracking_resolutions WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0094 down refused: % tracking resolution(s) exist; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS tracking_resolution_lines;
DROP TABLE IF EXISTS tracking_resolutions;

COMMIT;
