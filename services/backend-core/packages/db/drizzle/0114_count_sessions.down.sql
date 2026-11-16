-- 0114_count_sessions.down.sql
--
-- RT-1420 — rollback for 0114_count_sessions.sql.
--
-- REFUSES while any Count Session exists (they are the audit of a count; a
-- session's approval wrote Retail corrections that must stay explainable).
-- Otherwise drops the five tables and the settings columns this migration
-- added. The tables are FORCE ROW LEVEL SECURITY and the production migration
-- owner is not a superuser, so the guard reads under app.is_platform_admin and
-- each tenant's app.current_tenant (the 0087 pattern); a bare SELECT would see
-- no rows. A tenant that switched Count Sessions or the self-approval
-- exception on is NOT refused: both are dark-by-default flags that only gate
-- the sessions this guard already protects.

BEGIN;

DO $$
DECLARE
  t uuid;
  n bigint;
  rows_found bigint := 0;
BEGIN
  IF to_regclass('count_sessions') IS NULL THEN
    RETURN;
  END IF;
  LOCK TABLE count_sessions IN ACCESS EXCLUSIVE MODE;
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE 'SELECT count(*) FROM count_sessions WHERE tenant_id = $1' INTO n USING t;
    rows_found := rows_found + n;
  END LOOP;
  IF rows_found > 0 THEN
    RAISE EXCEPTION '0114 down refused: % count session(s) exist; back up and delete them explicitly first', rows_found;
  END IF;
END
$$;

DROP TABLE IF EXISTS count_late_event_findings;
DROP TABLE IF EXISTS count_observations;
DROP TABLE IF EXISTS count_session_expected;
DROP TABLE IF EXISTS count_session_lines;
DROP TABLE IF EXISTS count_sessions;

ALTER TABLE tenant_inventory_settings
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_count_self_approval_reason,
  DROP CONSTRAINT IF EXISTS tenant_inventory_settings_count_self_approval_change_pair,
  DROP COLUMN IF EXISTS count_self_approval_changed_by,
  DROP COLUMN IF EXISTS count_self_approval_changed_at,
  DROP COLUMN IF EXISTS count_self_approval_reason,
  DROP COLUMN IF EXISTS count_self_approval_enabled,
  DROP COLUMN IF EXISTS count_sessions_enabled;

COMMIT;
