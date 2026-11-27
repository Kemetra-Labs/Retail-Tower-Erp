-- 0141_auth_tokens_pending_connector_credential_idx — Jira RT-1362 S2 (follows 0140), `[GATED: migration]` (RT-1362
-- comments 19102 and 19107). At most ONE PENDING unrevoked connector credential per registration: the overlap
-- rotation's replacement (`pending_rotation_request_id IS NOT NULL`, 0139). A repeat of the credential call will
-- revoke the unpresented pending credential before it issues the next one, in one transaction, so this index is the
-- backstop against two concurrent issues. No row has a pending marker, so the build finds nothing to refuse.
-- A dedicated single-statement CONCURRENTLY migration for the same reasons as 0140, and deliberately NO
-- `IF NOT EXISTS` (see 0117).
CREATE UNIQUE INDEX CONCURRENTLY uq_auth_tokens_pending_connector_credential ON auth_tokens (connector_registration_id) WHERE scope = 'connector' AND revoked_at IS NULL AND pending_rotation_request_id IS NOT NULL;
