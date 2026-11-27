-- 0140_auth_tokens_current_connector_credential_idx.down.sql — reverses 0140 (RT-1362 S2). One statement:
-- DROP INDEX CONCURRENTLY cannot run inside a transaction block. IF EXISTS so a rollback after a failed build still
-- completes. The 0021 index stays, so the one-unrevoked-credential rule holds throughout.
DROP INDEX CONCURRENTLY IF EXISTS uq_auth_tokens_current_connector_credential;
