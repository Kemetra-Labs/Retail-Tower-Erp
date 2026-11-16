-- Rollback of 0118_count_late_compensation (RT-1424). It also drops `erp_stock_import_rows.posting_date` and `posting_time`: the
-- stamps captured after 0118 are discarded (the rows themselves stay). Refuses while any compensation or `erp_absorbed`
-- effect exists: the compensation row is the only record that links the Retail effect to the ERP document that
-- absorbed it, and an `erp_absorbed` effect cannot survive the narrower state CHECK. Back up and resolve explicitly.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  m bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('count_late_compensations') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE count_late_compensations IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM count_late_compensations WHERE tenant_id = $1' INTO n USING t;
    EXECUTE 'SELECT count(*) FROM inventory_effect_integration WHERE tenant_id = $1 AND state = ''erp_absorbed'''
      INTO m USING t;
    rows_found := rows_found + n + m;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0118 down refused: % late-event compensation / erp_absorbed row(s) exist; back up and resolve them explicitly first', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS count_late_compensations;

ALTER TABLE inventory_effect_integration
  DROP CONSTRAINT IF EXISTS inventory_effect_integration_erp_absorbed_shape,
  DROP CONSTRAINT IF EXISTS inventory_effect_integration_state_allowed;
ALTER TABLE inventory_effect_integration
  ADD CONSTRAINT inventory_effect_integration_state_allowed
    CHECK (state IN ('not_posted', 'pending', 'confirmed', 'rejected', 'reconciliation_required',
                     'external', 'erp_neutral'));

ALTER TABLE erp_stock_import_rows
  DROP CONSTRAINT IF EXISTS erp_stock_import_rows_posting_stamp_pair;
ALTER TABLE erp_stock_import_rows
  DROP COLUMN IF EXISTS posting_time,
  DROP COLUMN IF EXISTS posting_date;

COMMIT;
