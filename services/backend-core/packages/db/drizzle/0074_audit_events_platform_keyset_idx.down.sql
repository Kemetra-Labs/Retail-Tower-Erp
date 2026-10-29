-- 0074_audit_events_platform_keyset_idx.down.sql - reverses 0074_audit_events_platform_keyset_idx.sql (RT-808).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop takes no lock that blocks audit reads or writes. IF
-- EXISTS so a rollback after a failed (invalid, then manually dropped) build
-- still completes. The platform audit read falls back to the Seq Scan + Sort
-- plan; no audit row is touched.

DROP INDEX CONCURRENTLY IF EXISTS audit_events_platform_time_idx;
