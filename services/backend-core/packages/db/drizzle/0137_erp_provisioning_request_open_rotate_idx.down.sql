-- 0137_erp_provisioning_request_open_rotate_idx.down.sql — reverses 0137 (RT-1362 S2).
-- One statement: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the runner wraps a
-- multi-statement file in one. IF EXISTS so a rollback after a failed (invalid, then manually dropped) build
-- still completes.
DROP INDEX CONCURRENTLY IF EXISTS uq_erp_provisioning_request_open_credential_rotate;
