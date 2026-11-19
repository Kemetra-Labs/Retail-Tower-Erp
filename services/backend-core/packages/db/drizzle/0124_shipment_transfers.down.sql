-- Rollback of 0124_shipment_transfers (RT-1513). REFUSES while any shipment Transfer, reservation or transfer leg
-- exists: they are the audit of stock that left a store and the only link between a dispatch or receipt and its ERP
-- document. Back them up and delete them explicitly first. A tenant that switched shipment transfers on is NOT refused
-- by the switch alone: it is a dark-by-default flag that only gates the rows this guard already protects.
-- The tables are FORCE ROW LEVEL SECURITY and the production migration owner is not a superuser, so the guard reads
-- under app.is_platform_admin and each tenant's app.current_tenant (the 0114 / 0116 pattern); a bare SELECT would see
-- no rows.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('shipment_transfers') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE shipment_transfers IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE inventory_reservations IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE erpnext_posting_status IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM shipment_transfers WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
    EXECUTE 'SELECT count(*) FROM inventory_reservations WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
    EXECUTE 'SELECT count(*) FROM erpnext_posting_status WHERE tenant_id = $1 AND kind IN (''transfer_dispatch'', ''transfer_receive'')'
      INTO n USING t;
    rows_found := rows_found + n;
    EXECUTE 'SELECT count(*) FROM erpnext_warehouse_map WHERE tenant_id = $1 AND purpose = ''transit''' INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0124 down refused: % shipment transfer, reservation, transfer leg or transit map row(s) exist; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS transfer_posting_lines;
DROP TABLE IF EXISTS transfer_postings;
DROP TABLE IF EXISTS shipment_transfer_discrepancies;
DROP TABLE IF EXISTS shipment_transfer_receipt_lines;
DROP TABLE IF EXISTS shipment_transfer_receipts;
DROP TABLE IF EXISTS shipment_transfer_lines;
DROP TABLE IF EXISTS shipment_transfers;
DROP TABLE IF EXISTS inventory_reservations;

ALTER TABLE erpnext_posting_status
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_count_shape,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_kind_valid;
ALTER TABLE erpnext_posting_status
  ADD CONSTRAINT erpnext_posting_status_kind_valid
    CHECK (kind IN ('sale_post', 'reversal', 'inventory_count')),
  ADD CONSTRAINT erpnext_posting_status_count_shape
    CHECK ((kind = 'inventory_count'
            AND sale_id IS NULL
            AND count_session_id IS NOT NULL AND count_chunk IS NOT NULL
            AND count_chunk_total IS NOT NULL AND count_posting_datetime IS NOT NULL)
        OR (kind <> 'inventory_count'
            AND sale_id IS NOT NULL
            AND count_session_id IS NULL AND count_chunk IS NULL
            AND count_chunk_total IS NULL AND count_posting_datetime IS NULL));

DROP INDEX IF EXISTS "UQ_idx_erpnext_warehouse_map_transit_active";
ALTER TABLE erpnext_warehouse_map
  DROP CONSTRAINT IF EXISTS erpnext_warehouse_map_transit_has_no_store,
  DROP CONSTRAINT IF EXISTS erpnext_warehouse_map_purpose_valid;
ALTER TABLE erpnext_warehouse_map
  ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE erpnext_warehouse_map
  ADD CONSTRAINT erpnext_warehouse_map_purpose_valid CHECK (purpose IN ('stock', 'returns'));

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_delayed_threshold_range,
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_shipment_change_pair,
  DROP COLUMN IF EXISTS delayed_transfer_threshold_days,
  DROP COLUMN IF EXISTS shipment_transfers_changed_by,
  DROP COLUMN IF EXISTS shipment_transfers_changed_at,
  DROP COLUMN IF EXISTS shipment_transfers_enabled;

COMMIT;
