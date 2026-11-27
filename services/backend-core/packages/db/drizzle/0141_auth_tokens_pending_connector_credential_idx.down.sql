-- 0141_auth_tokens_pending_connector_credential_idx.down.sql — reverses 0141 (RT-1362 S2). One statement (see 0140
-- down); IF EXISTS so a rollback after a failed build still completes.
DROP INDEX CONCURRENTLY IF EXISTS uq_auth_tokens_pending_connector_credential;
