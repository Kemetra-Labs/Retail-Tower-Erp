-- 0075_erpnext_warehouse_map_ref_unique.down.sql - reverses 0075_erpnext_warehouse_map_ref_unique.sql (RT-433).
--
-- Drops the unique reverse index and restores 0018's non-unique
-- idx_erpnext_warehouse_map_ref on the same key and predicate. Two stores may
-- then map one Warehouse again. No data changes.

BEGIN;

DROP INDEX IF EXISTS "UQ_idx_erpnext_warehouse_map_ref_active";

CREATE INDEX IF NOT EXISTS idx_erpnext_warehouse_map_ref
  ON erpnext_warehouse_map (tenant_id, erpnext_warehouse_ref)
  WHERE retired_at IS NULL;

COMMIT;
