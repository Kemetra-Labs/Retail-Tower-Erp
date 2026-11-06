-- 0081_erpnext_reconciliation_run_running_idx.down.sql - reverses 0081_erpnext_reconciliation_run_running_idx.sql (RT-185).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop takes no lock that blocks run reads or writes. IF
-- EXISTS so a rollback after a failed (invalid, then manually dropped) build
-- still completes. The running-run reads fall back to the 0020 tenant/time
-- index or a scan; no run row is touched.

DROP INDEX CONCURRENTLY IF EXISTS idx_erpnext_reconciliation_run_tenant_store_running;
