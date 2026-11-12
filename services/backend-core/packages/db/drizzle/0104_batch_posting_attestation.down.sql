-- 0104_batch_posting_attestation.down.sql
--
-- RT-452 — rollback for 0104_batch_posting_attestation.sql.
--
-- Drops ONLY the three columns this migration added to
-- `tenant_inventory_settings` and their two CHECK constraints. No other
-- column, policy, constraint or row is touched.
--
-- The attestation is the owner's only record of the batch-posting evidence, so
-- the rollback REFUSES while any tenant holds one: dropping the columns would
-- discard it with no audit trail to restore it from. The table is FORCE ROW
-- LEVEL SECURITY and the production migration owner is not a superuser, so the
-- guard reads under app.is_platform_admin and each tenant's app.current_tenant
-- (the 0086 pattern); a bare SELECT would see no rows.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0104-batch-posting-attestation.spec.ts and
-- the full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DO $$
DECLARE
  t uuid;
  attested bigint := 0;
BEGIN
  -- Rerunnable: once the column is gone there is nothing to guard (a plpgsql
  -- statement is planned on first execution, so the loop below is never
  -- planned against a dropped column). The column is read from pg_attribute
  -- (information_schema hides columns by privilege).
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('tenant_inventory_settings')
       AND attname = 'erp_batch_posting_attested_at'
       AND NOT attisdropped
  ) THEN
    RETURN;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    attested := attested
      + (SELECT count(*) FROM tenant_inventory_settings
          WHERE tenant_id = t AND erp_batch_posting_attested_at IS NOT NULL);
  END LOOP;
  IF attested > 0 THEN
    RAISE EXCEPTION '0104 down refused: % tenant(s) hold a batch-posting attestation; it would be discarded', attested;
  END IF;
END
$$;

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_batch_posting_evidence_ref,
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_batch_posting_attest_together;

ALTER TABLE tenant_inventory_settings
  DROP COLUMN IF EXISTS erp_batch_posting_evidence_ref,
  DROP COLUMN IF EXISTS erp_batch_posting_attested_by,
  DROP COLUMN IF EXISTS erp_batch_posting_attested_at;

COMMIT;
