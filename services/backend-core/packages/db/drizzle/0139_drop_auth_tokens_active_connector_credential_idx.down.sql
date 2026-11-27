-- 0139_drop_auth_tokens_active_connector_credential_idx.down.sql — reverses 0139 (RT-1362 S2): rebuilds the 0021
-- index, at most one unrevoked connector credential per registration, CONCURRENTLY (one statement, see 0137).
-- It FAILS (23505, leaving an INVALID index to drop with `DROP INDEX CONCURRENTLY` before a retry) while any
-- registration has a pending credential next to its current one: roll the S2 runtime back first and revoke the
-- pending credentials (the current ones keep working), then re-run. That failure is deliberate: it refuses to
-- restore a rule the data no longer meets.
CREATE UNIQUE INDEX CONCURRENTLY uq_auth_tokens_active_connector_credential ON auth_tokens (connector_registration_id) WHERE scope = 'connector' AND revoked_at IS NULL;
