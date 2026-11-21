-- 0130_sync_failure_alerts.down.sql - reverses 0130_sync_failure_alerts.sql (RT-1034).
--
-- Drops both alert tables (deliveries first: it references the windows). The
-- only effect is that a condition that is open at rollback time alerts again
-- after a later re-apply; no posting, reconciliation or sale data is touched.
-- Roll back the worker first: with the tables gone the alert sweep fails.

BEGIN;

DROP TABLE IF EXISTS sync_failure_alert_deliveries;
DROP TABLE IF EXISTS sync_failure_alert_windows;

COMMIT;
