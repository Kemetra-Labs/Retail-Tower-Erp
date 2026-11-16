-- 0115_connector_health_count_capability.down.sql
--
-- RT-1427 — rollback for 0115. Drops the four evidence columns and their checks.
-- The columns hold self-reported, re-sent-every-minute telemetry, so dropping them
-- loses nothing that the next heartbeat does not restore.

BEGIN;

ALTER TABLE connector_health
  DROP CONSTRAINT IF EXISTS connector_health_back_dated_role_pair,
  DROP CONSTRAINT IF EXISTS connector_health_work_item_kinds_bounded,
  DROP CONSTRAINT IF EXISTS connector_health_back_dated_role_status_valid;

ALTER TABLE connector_health
  DROP COLUMN IF EXISTS back_dated_role_reported_at,
  DROP COLUMN IF EXISTS back_dated_role_checked_at,
  DROP COLUMN IF EXISTS back_dated_role_status,
  DROP COLUMN IF EXISTS accepted_work_item_kinds;

COMMIT;
