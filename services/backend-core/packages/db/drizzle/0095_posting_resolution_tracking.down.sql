-- 0095_posting_resolution_tracking.down.sql
--
-- RT-451 S6: rollback for 0095_posting_resolution_tracking.sql. Drops the
-- four CHECKs and the four tracking columns of erpnext_posting_resolution.
--
-- The rollback REFUSES while any resolution line has a frozen tracking
-- identity: without its column, the code before 0095 would offer that
-- intent with no Batch (and would release a held row-3 intent), and the
-- Connector would post a batch Item without its Batch or reject it. Back up,
-- decide, and remove those intents explicitly first (the 0072 / 0087 / 0094
-- pattern). Rows with only `tracking_mode` set (untracked or switched-off
-- lines) lose nothing the code before 0095 reads.
--
-- The table is FORCE ROW LEVEL SECURITY and the production migration owner is
-- not a superuser, so the guard reads under app.is_platform_admin and each
-- tenant's app.current_tenant; a bare SELECT would see no rows. The table is
-- locked ACCESS EXCLUSIVE before the count, so no tracked line can be frozen
-- between the guard and the DROP.
--
-- Rerunnable: once the column is gone there is nothing to guard. The count is
-- a dynamic statement, so it is never planned against a dropped column.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0095-posting-resolution-tracking.spec.ts and
-- the full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'erpnext_posting_resolution'
       AND column_name = 'tracking_identity_id'
  ) THEN
    RETURN;
  END IF;
  LOCK TABLE erpnext_posting_resolution IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM erpnext_posting_resolution
              WHERE tenant_id = $1 AND tracking_identity_id IS NOT NULL'
       INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0095 down refused: % posting resolution line(s) carry a frozen tracking identity; back up and remove those intents explicitly first', rows_found;
  END IF;
END
$$;

ALTER TABLE erpnext_posting_resolution
  DROP CONSTRAINT IF EXISTS erpnext_posting_resolution_tracking_consistent,
  DROP CONSTRAINT IF EXISTS erpnext_posting_resolution_hold_cause_valid,
  DROP CONSTRAINT IF EXISTS erpnext_posting_resolution_batch_ref_length,
  DROP CONSTRAINT IF EXISTS erpnext_posting_resolution_tracking_mode_valid;
ALTER TABLE erpnext_posting_resolution
  DROP COLUMN IF EXISTS erp_hold_cause,
  DROP COLUMN IF EXISTS erpnext_batch_ref,
  DROP COLUMN IF EXISTS tracking_identity_id,
  DROP COLUMN IF EXISTS tracking_mode;

COMMIT;
