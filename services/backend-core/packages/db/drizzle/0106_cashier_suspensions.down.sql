-- 0106_cashier_suspensions.down.sql - reverses 0106_cashier_suspensions.sql (RT-1138).
--
-- Drops ONLY the `cashier_suspensions` table (its policies and constraints go
-- with it). SAFETY (fail-open): dropping the table makes every suspended
-- cashier admissible again, so this refuses while any cashier is still
-- suspended. Reactivate them first (or accept the loss deliberately by
-- deleting the rows as the migration owner). Roll back the RT-1138 API first;
-- with the table gone, the suspension routes, the admission check and the
-- cashier roster return 500.
--
-- The table is FORCE ROW LEVEL SECURITY and the production migration owner is
-- not a superuser (docs/operations/database-roles.md), so the guard counts
-- under each tenant's app.current_tenant (the 0078 pattern); a bare SELECT
-- would see no rows, pass, and drop every suspension. The count runs through
-- EXECUTE so the script can be re-run once the table is gone (PL/pgSQL would
-- otherwise plan the missing table and fail with 42P01).

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  suspended bigint := 0;
BEGIN
  IF to_regclass('cashier_suspensions') IS NOT NULL THEN
    PERFORM set_config('app.is_platform_admin', 'true', true);
    PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
    FOR t IN SELECT id FROM tenants LOOP
      PERFORM set_config('app.current_tenant', t::text, true);
      EXECUTE 'SELECT count(*) FROM cashier_suspensions WHERE tenant_id = $1 AND status = ''suspended'''
        INTO n USING t;
      suspended := suspended + n;
    END LOOP;
    IF suspended > 0 THEN
      RAISE EXCEPTION '0106 down refused: % suspended cashier(s) stored; reactivate them first', suspended
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS cashier_suspensions;

COMMIT;
