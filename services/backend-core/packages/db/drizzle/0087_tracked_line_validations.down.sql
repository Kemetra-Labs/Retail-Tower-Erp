-- 0087_tracked_line_validations.down.sql
--
-- RT-451 S2 — rollback for 0087_tracked_line_validations.sql.
--
-- Drops ONLY the `tracked_line_validations` table (with its index, policies
-- and grants). Every validation record is the server-side audit of what a till
-- was told about a lot, and a sale line cites it (RT-451 S3), so the rollback
-- REFUSES while any record exists: back up, decide, and delete them explicitly
-- first (the 0072 pattern). The table is FORCE ROW LEVEL SECURITY and the
-- production migration owner is not a superuser, so the guard reads under
-- app.is_platform_admin and each tenant's app.current_tenant; a bare SELECT
-- would see no rows and drop them.
--
-- The table is locked ACCESS EXCLUSIVE before the count, so no record can be
-- committed between the guard and the DROP.
--
-- Rerunnable: once the table is gone there is nothing to guard. The table is
-- resolved through the search path with to_regclass, as the DROP below
-- resolves it, and the count is a dynamic statement, so the guard is never
-- planned against a dropped table.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0087-tracked-line-validations.spec.ts and
-- the full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('tracked_line_validations') IS NULL THEN
    RETURN;
  END IF;
  -- Hold the table from the count to the DROP: a live API cannot commit a
  -- record after the count and lose it to the DROP.
  LOCK TABLE tracked_line_validations IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM tracked_line_validations WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0087 down refused: % tracked line validation record(s) exist; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS tracked_line_validations;

COMMIT;
