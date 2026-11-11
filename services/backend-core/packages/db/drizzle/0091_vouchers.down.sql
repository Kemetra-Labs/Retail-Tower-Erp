-- 0091_vouchers.down.sql
--
-- RT-1107 (RT-1098 I-2) -- rollback for 0091_vouchers.sql.
--
-- Drops `voucher_eligible_stores`, then `vouchers` (with their indexes,
-- trigger, policies and grants). A voucher is a stored value a customer may
-- hold, so the rollback REFUSES while any voucher exists: back up, decide, and
-- have a superuser remove the rows first (neither table has a DELETE policy,
-- so the migration owner cannot). Both tables are FORCE ROW LEVEL SECURITY and
-- the production migration owner is not a superuser, so the guard reads under
-- app.is_platform_admin and each tenant's app.current_tenant; a bare SELECT
-- would see no rows and drop them. Eligible-store rows cannot exist without
-- their voucher (composite FK), so counting vouchers covers both.
--
-- Both tables are locked ACCESS EXCLUSIVE before the count, so no row can be
-- committed between the guard and the DROPs.
--
-- Rerunnable: once the tables are gone there is nothing to guard (to_regclass,
-- and the count is a dynamic statement, so it is never planned against a
-- dropped table).
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0091-vouchers.spec.ts and the full-chain
-- down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('vouchers') IS NULL THEN
    RETURN;
  END IF;
  -- Same order as runtime writes (vouchers, then voucher_eligible_stores).
  LOCK TABLE vouchers IN ACCESS EXCLUSIVE MODE;
  IF to_regclass('voucher_eligible_stores') IS NOT NULL THEN
    LOCK TABLE voucher_eligible_stores IN ACCESS EXCLUSIVE MODE;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM vouchers WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0091 down refused: % voucher(s) exist; the tables have no DELETE policy, so a superuser must remove the rows (after a backup, under the data-retention procedure) before rollback', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS voucher_eligible_stores;
DROP TABLE IF EXISTS vouchers;

COMMIT;
