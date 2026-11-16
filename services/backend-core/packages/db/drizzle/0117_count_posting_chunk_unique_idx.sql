-- 0117_count_posting_chunk_unique_idx — Jira RT-1423 (follows 0116): the unique chunk key of the count work items,
-- UNIQUE (tenant, count_session_id, count_chunk), the database backstop of idempotent emission. Partial: only
-- count chunks carry a session, so every sale row stays out of it. A dedicated single-statement CONCURRENTLY
-- migration (precedents 0036, 0048), so building it never blocks the posting feed's writes.
-- If a build is interrupted it can leave an INVALID index of this name: drop it (`DROP INDEX CONCURRENTLY`) and
-- re-run; `IF NOT EXISTS` would otherwise skip the invalid one.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_idx_erpnext_posting_status_count_chunk" ON erpnext_posting_status (tenant_id, count_session_id, count_chunk) WHERE count_session_id IS NOT NULL;
