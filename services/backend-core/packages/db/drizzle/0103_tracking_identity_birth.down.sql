-- 0103_tracking_identity_birth.down.sql
--
-- RT-453 — rollback for 0103_tracking_identity_birth.sql.
--
-- Drops the four tables (with their indexes, policies and grants), the
-- awaiting-row index and `erp_stock_import_rows.event_type`, and restores the 0066 CHECK on
-- erpnext_reconciliation_result (without `tracking_mismatch`).
--
-- REFUSES while any birth, row resolution or identity anchor exists, or any
-- reconciliation result is classed `tracking_mismatch`: births are the
-- provenance of identities already in use, resolutions are the audit of
-- effects already written, and anchors are the baseline of positions. Back
-- up, decide, and delete them explicitly first. The tables are FORCE ROW
-- LEVEL SECURITY and the production migration owner is not a superuser, so
-- the guard reads under app.is_platform_admin and each tenant's
-- app.current_tenant (the 0087 / 0096 pattern).
--
-- The births and anchors tables are locked ACCESS EXCLUSIVE before the count,
-- so nothing can be written between the guard and the DROP. Rerunnable: once
-- the tables are gone there is nothing to guard.
--
-- Supports the UP -> DOWN -> UP round trip exercised by
-- packages/db/__tests__/migration/0102-tracking-identity-birth.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  found bigint := 0;
BEGIN
  IF to_regclass('tracking_identity_births') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE tracking_identity_births, erp_stock_import_row_resolutions,
             inventory_identity_anchors, inventory_identity_anchor_lines
    IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT (SELECT count(*) FROM tracking_identity_births WHERE tenant_id = $1)
                  + (SELECT count(*) FROM erp_stock_import_row_resolutions WHERE tenant_id = $1)
                  + (SELECT count(*) FROM inventory_identity_anchors WHERE tenant_id = $1)
                  + (SELECT count(*) FROM erpnext_reconciliation_result
                      WHERE tenant_id = $1 AND mismatch_class = ''tracking_mismatch'')'
      INTO n USING t;
    found := found + n;
  END LOOP;
  IF found > 0 THEN
    RAISE EXCEPTION '0103 down refused: % identity birth(s), import row resolution(s), identity anchor(s) or tracking_mismatch result(s) exist; back up and delete them explicitly first', found;
  END IF;
END
$$;

DROP TABLE IF EXISTS inventory_identity_anchor_lines;
DROP TABLE IF EXISTS inventory_identity_anchors;
DROP TABLE IF EXISTS erp_stock_import_row_resolutions;
DROP TABLE IF EXISTS tracking_identity_births;
DROP INDEX IF EXISTS idx_erp_stock_import_rows_awaiting_batch;
ALTER TABLE erp_stock_import_rows DROP CONSTRAINT IF EXISTS erp_stock_import_rows_event_type_allowed;
ALTER TABLE erp_stock_import_rows DROP COLUMN IF EXISTS event_type;

ALTER TABLE erpnext_reconciliation_result
  DROP CONSTRAINT IF EXISTS erpnext_reconciliation_result_class_valid;
ALTER TABLE erpnext_reconciliation_result
  ADD CONSTRAINT erpnext_reconciliation_result_class_valid
    CHECK (mismatch_class IN (
      'match', 'quantity_divergence', 'unmapped_store', 'unmapped_item',
      'dp2_only', 'erpnext_only', 'negative_balance_flagged',
      'expected_pending_erp', 'expected_pending_retail', 'erp_snapshot_stale',
      'uom_mismatch'
    )) NOT VALID;

COMMIT;

-- Validated again after the commit, as 0066 left it (SHARE UPDATE EXCLUSIVE:
-- reads and writes continue). The guard above refused any `tracking_mismatch`
-- row, so every row satisfies the restored CHECK.
ALTER TABLE erpnext_reconciliation_result
  VALIDATE CONSTRAINT erpnext_reconciliation_result_class_valid;
