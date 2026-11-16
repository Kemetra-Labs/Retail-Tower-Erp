-- Rollback of 0116_count_posting_chunks (RT-1423). Refuses while any count chunk exists: a chunk is the
-- only record that links an approved count to its ERP document. Back up and delete them explicitly first.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('erpnext_posting_status') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE erpnext_posting_status IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM erpnext_posting_status WHERE tenant_id = $1 AND kind = ''inventory_count'''
      INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0116 down refused: % inventory_count posting row(s) exist; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS count_posting_lines;

DROP INDEX IF EXISTS "UQ_idx_erpnext_posting_status_count_chunk";

ALTER TABLE erpnext_posting_status
  DROP CONSTRAINT IF EXISTS fk_erpnext_posting_status_count_session,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_noop_only_count,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_count_datetime_format,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_count_chunk_bounds,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_count_shape,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_status_valid,
  DROP CONSTRAINT IF EXISTS erpnext_posting_status_kind_valid;

ALTER TABLE erpnext_posting_status
  DROP COLUMN IF EXISTS count_posting_datetime,
  DROP COLUMN IF EXISTS count_chunk_total,
  DROP COLUMN IF EXISTS count_chunk,
  DROP COLUMN IF EXISTS count_session_id,
  ALTER COLUMN sale_id SET NOT NULL;

ALTER TABLE erpnext_posting_status
  ADD CONSTRAINT erpnext_posting_status_kind_valid CHECK (kind IN ('sale_post', 'reversal')),
  ADD CONSTRAINT erpnext_posting_status_status_valid
    CHECK (status IN ('pending', 'posted', 'failed_transient', 'permanently_rejected'));

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_count_sessions_change_pair,
  DROP COLUMN IF EXISTS count_sessions_changed_by,
  DROP COLUMN IF EXISTS count_sessions_changed_at;

ALTER TABLE inventory_effect_integration
  DROP CONSTRAINT IF EXISTS inventory_effect_integration_confirmed_document;
ALTER TABLE inventory_effect_integration
  ADD CONSTRAINT inventory_effect_integration_confirmed_document
    CHECK (state <> 'confirmed' OR erp_document_ref IS NOT NULL);

COMMIT;
