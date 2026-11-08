-- 0089_sale_capture_tracking.down.sql
--
-- RT-451 S3 — rollback for 0089_sale_capture_tracking.sql.
--
-- Drops ONLY what 0089 added: the `sale_line_findings` table (with its
-- indexes, policies and grants), the seven `sale_lines.tracking_*` columns,
-- the three `sales` columns, and their CHECK constraints. No other column,
-- policy, constraint or row is touched.
--
-- Every value these hold is a fact of a captured sale (the tracking a till
-- sold, its classification, the till's safety provenance) or the audit of it
-- (a finding), so the rollback REFUSES while any of it exists: back up,
-- decide, and remove it explicitly first (the 0072 / 0087 pattern). The three
-- tables are FORCE ROW LEVEL SECURITY and the production migration owner is
-- not a superuser, so the guard reads under app.is_platform_admin and each
-- tenant's app.current_tenant; a bare SELECT would see no rows.
--
-- `sales`, `sale_lines` and `sale_line_findings` are locked ACCESS EXCLUSIVE
-- (the mode the DROPs below take anyway, parent first) before the checks, so no
-- capture can commit tracked data between the guard and the DROPs.
-- lock_timeout 2s per request, as the up.
--
-- Rerunnable: each part is guarded only while its object still exists. The
-- table is resolved with to_regclass and the columns are read from
-- pg_attribute (information_schema hides columns by privilege), both through
-- the search path as the DROPs below resolve them, and every count is a
-- dynamic statement, so the guard is never planned against a dropped object.
-- Each check is an EXISTS that stops at its first row.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0089-sale-capture-tracking.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  t uuid;
  found_in text := NULL;
  has_findings boolean := to_regclass('sale_line_findings') IS NOT NULL;
  has_line_cols boolean := EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('sale_lines')
       AND attname = 'tracking_class'
       AND NOT attisdropped);
  has_sale_cols boolean := EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = to_regclass('sales')
       AND attname = 'tracking_status'
       AND NOT attisdropped);
  hit boolean;
BEGIN
  IF NOT (has_findings OR has_line_cols OR has_sale_cols) THEN
    RETURN;
  END IF;
  -- Hold the tables from the checks to the DROPs (parent first, as capture
  -- writes them): a live API cannot commit tracked data after a check.
  LOCK TABLE sales, sale_lines IN ACCESS EXCLUSIVE MODE;
  IF has_findings THEN
    LOCK TABLE sale_line_findings IN ACCESS EXCLUSIVE MODE;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  -- EXISTS, not count(*): each check stops at its first row.
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    IF has_findings THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM sale_line_findings WHERE tenant_id = $1)' INTO hit USING t;
      IF hit THEN found_in := 'sale_line_findings'; EXIT; END IF;
    END IF;
    IF has_line_cols THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM sale_lines WHERE tenant_id = $1
                  AND (tracking_identity_id IS NOT NULL OR tracking_class IS NOT NULL))'
        INTO hit USING t;
      IF hit THEN found_in := 'sale_lines'; EXIT; END IF;
    END IF;
    IF has_sale_cols THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM sales WHERE tenant_id = $1
                  AND (safety_revision IS NOT NULL OR safety_synced_at IS NOT NULL
                       OR tracking_status IS NOT NULL))'
        INTO hit USING t;
      IF hit THEN found_in := 'sales'; EXIT; END IF;
    END IF;
  END LOOP;
  IF found_in IS NOT NULL THEN
    RAISE EXCEPTION '0089 down refused: tracked sale data exists (%: a finding, a line''s tracking, or a sale''s safety provenance or tracking status); back up and remove it explicitly first',
      found_in;
  END IF;
END
$$;

DROP TABLE IF EXISTS sale_line_findings;

ALTER TABLE sales
  DROP CONSTRAINT IF EXISTS sales_safety_revision_non_negative,
  DROP CONSTRAINT IF EXISTS sales_tracking_status_allowed;

ALTER TABLE sales
  DROP COLUMN IF EXISTS tracking_status,
  DROP COLUMN IF EXISTS safety_synced_at,
  DROP COLUMN IF EXISTS safety_revision;

ALTER TABLE sale_lines
  DROP CONSTRAINT IF EXISTS sale_lines_tracking_snapshot_whole,
  DROP CONSTRAINT IF EXISTS sale_lines_tracking_code_shape,
  DROP CONSTRAINT IF EXISTS sale_lines_tracking_expiry_in_range,
  DROP CONSTRAINT IF EXISTS sale_lines_tracking_selection_allowed,
  DROP CONSTRAINT IF EXISTS sale_lines_tracking_class_allowed,
  DROP CONSTRAINT IF EXISTS sale_lines_tracking_unresolved_reason_allowed,
  DROP CONSTRAINT IF EXISTS sale_lines_tracking_unresolved_reason_iff,
  DROP CONSTRAINT IF EXISTS sale_lines_tracking_missing_has_no_snapshot;

ALTER TABLE sale_lines
  DROP COLUMN IF EXISTS tracking_unresolved_reason,
  DROP COLUMN IF EXISTS tracking_class,
  DROP COLUMN IF EXISTS tracking_validation_id,
  DROP COLUMN IF EXISTS tracking_selection,
  DROP COLUMN IF EXISTS tracking_expiry_date,
  DROP COLUMN IF EXISTS tracking_code,
  DROP COLUMN IF EXISTS tracking_identity_id;

COMMIT;
