-- 0099_sale_tender_voucher.down.sql
--
-- RT-1114 (RT-1098 R-4a): rollback for 0099_sale_tender_voucher.sql.
--
-- Drops ONLY what 0099 added: the redemption FK, the
-- voucher-only CHECK, the `sale_tenders.redemption_id` column and the
-- `voucher_redemptions_tenant_store_id_uk` key. Then it restores the 0033
-- method CHECK (cash, card_external), validated. No row is touched.
--
-- A voucher tender is a fact of a captured sale (how it was paid), so the
-- rollback REFUSES while any is stored: back up, decide, and remove it
-- explicitly first (sale_tenders has no DELETE policy, so a superuser must).
-- The 0072 / 0089 / 0092 pattern applies. sale_tenders is FORCE ROW LEVEL SECURITY
-- and the production migration owner is not a superuser, so the guard reads
-- under app.is_platform_admin and each tenant's app.current_tenant; a bare
-- SELECT would see no rows and restore a CHECK that existing rows break.
--
-- sales and sale_tenders are locked ACCESS EXCLUSIVE (parent first, as capture
-- writes them) before the check, so no capture can commit a voucher tender
-- between the guard and the DDL. lock_timeout 2s, as the up.
--
-- Rerunnable: once `redemption_id` is gone there is nothing to guard (read
-- from pg_attribute; the count is a dynamic statement, so it is never planned
-- against a dropped column), and every DROP is IF EXISTS.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0099-sale-tender-voucher.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  hit boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('sale_tenders')
       AND attname = 'redemption_id'
       AND NOT attisdropped) THEN
    RETURN;
  END IF;
  LOCK TABLE sales, sale_tenders IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM sale_tenders
                             WHERE tenant_id = $1
                               AND (method = ''voucher'' OR redemption_id IS NOT NULL))'
      INTO hit USING t;
    IF hit THEN
      RAISE EXCEPTION '0099 down refused: tenant % has voucher sale tenders; they are sale facts and sale_tenders has no DELETE policy, so a superuser must remove them (after a backup, under the data-retention procedure) before rollback', t;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE sale_tenders DROP CONSTRAINT IF EXISTS fk_sale_tenders_redemption_tenant_store;
ALTER TABLE sale_tenders DROP CONSTRAINT IF EXISTS sale_tenders_redemption_voucher_only;
ALTER TABLE sale_tenders DROP COLUMN IF EXISTS redemption_id;

ALTER TABLE voucher_redemptions DROP CONSTRAINT IF EXISTS voucher_redemptions_tenant_store_id_uk;

-- Validated, as 0033 created it: the guard above proved no row breaks it, and
-- the scan runs under the ACCESS EXCLUSIVE lock already held.
ALTER TABLE sale_tenders DROP CONSTRAINT sale_tenders_method_valid;
ALTER TABLE sale_tenders
  ADD CONSTRAINT sale_tenders_method_valid CHECK (method IN ('cash', 'card_external'));

COMMIT;
