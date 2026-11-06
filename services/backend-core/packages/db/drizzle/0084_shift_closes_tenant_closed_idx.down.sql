-- 0084_shift_closes_tenant_closed_idx.down.sql - reverses 0084_shift_closes_tenant_closed_idx.sql (RT-429).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop takes no lock that blocks close reads or inserts. IF
-- EXISTS so a rollback after a failed (invalid, then manually dropped) build
-- still completes. The tenant-wide shift-close list falls back to sorting every
-- in-scope close; no close row is touched.

DROP INDEX CONCURRENTLY IF EXISTS idx_shift_closes_tenant_closed;
