-- 0092_voucher_redemptions.down.sql
--
-- RT-1111 (RT-1098 R-2) -- rollback for 0092_voucher_redemptions.sql.
--
-- Drops `voucher_redemptions`, then `voucher_redemption_intents` (with their
-- indexes, trigger and policies). A redemption is the audit fact that a
-- voucher was spent, so the rollback REFUSES while any intent or redemption
-- exists: back up, decide, and have a superuser remove the rows first (neither
-- table has a DELETE policy, so the migration owner cannot). Both tables are
-- FORCE ROW LEVEL SECURITY and the production migration owner is not a
-- superuser, so the guard reads under app.is_platform_admin and each tenant's
-- app.current_tenant; a bare SELECT would see no rows and drop them. A
-- redemption cannot exist without its intent (composite FK), but an intent can
-- exist without a redemption, so both are counted.
--
-- Both tables are locked ACCESS EXCLUSIVE before the count, so no row can be
-- committed between the guard and the DROPs.
--
-- Rerunnable: once the tables are gone there is nothing to guard (to_regclass,
-- and the counts are dynamic statements, so they are never planned against a
-- dropped table).
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0092-voucher-redemptions.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('voucher_redemption_intents') IS NULL AND to_regclass('voucher_redemptions') IS NULL THEN
    RETURN;
  END IF;
  -- Same order as runtime writes (intents, then redemptions).
  IF to_regclass('voucher_redemption_intents') IS NOT NULL THEN
    LOCK TABLE voucher_redemption_intents IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('voucher_redemptions') IS NOT NULL THEN
    LOCK TABLE voucher_redemptions IN ACCESS EXCLUSIVE MODE;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    IF to_regclass('voucher_redemption_intents') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM voucher_redemption_intents WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
    IF to_regclass('voucher_redemptions') IS NOT NULL THEN
      EXECUTE 'SELECT count(*) FROM voucher_redemptions WHERE tenant_id = $1' INTO n USING t;
      rows_found := rows_found + n;
    END IF;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0092 down refused: % voucher redemption intent/redemption row(s) exist; the tables have no DELETE policy, so a superuser must remove the rows (after a backup, under the data-retention procedure) before rollback', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS voucher_redemptions;
DROP TABLE IF EXISTS voucher_redemption_intents;

COMMIT;
