-- 0139_drop_auth_tokens_active_connector_credential_idx — Jira RT-1362 S2 (follows 0138), `[GATED: migration]`
-- (RT-1362 comment 19107: under OVERLAP rotation a registration holds its current credential and at most one
-- pending one, so the 0021 one-unrevoked-credential index changes). Drops `uq_auth_tokens_active_connector_credential`
-- now that 0137 (at most one current) and 0138 (at most one pending) are valid. Until the S2 runtime issues a pending
-- credential, every unrevoked connector credential is current, so 0137 alone keeps today's one-credential rule.
-- One statement, CONCURRENTLY: the drop takes no lock that blocks token issue or lookup. IF EXISTS so a re-run after
-- a manual drop completes.
DROP INDEX CONCURRENTLY IF EXISTS uq_auth_tokens_active_connector_credential;
