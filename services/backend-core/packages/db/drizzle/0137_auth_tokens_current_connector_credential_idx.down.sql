-- 0137_auth_tokens_current_connector_credential_idx.down.sql — reverses 0137 (RT-1362 S2).
-- One statement: DROP INDEX CONCURRENTLY cannot run inside a transaction block, and the runner wraps a
-- multi-statement file in one. IF EXISTS so a rollback after a failed (invalid, then manually dropped) build
-- still completes. Run 0139 down first: it restores the 0021 index, so dropping this one never leaves a
-- registration without a one-current-credential rule.
DROP INDEX CONCURRENTLY IF EXISTS uq_auth_tokens_current_connector_credential;
