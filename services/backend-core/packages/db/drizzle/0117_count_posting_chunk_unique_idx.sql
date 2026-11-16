-- 0117_count_posting_chunk_unique_idx — Jira RT-1423 (follows 0116): the unique chunk key of the count work items,
-- UNIQUE (tenant, count_session_id, count_chunk), the database backstop of idempotent emission. Partial: only
-- count chunks carry a session, so every sale row stays out of it. A dedicated single-statement CONCURRENTLY
-- migration (precedents 0036, 0048), so building it never blocks the posting feed's writes.
-- Deliberately NO `IF NOT EXISTS`: an interrupted build can leave an INVALID index of this name, and a retry that
-- skipped it would be recorded as applied while `ON CONFLICT` cannot use an invalid index. With the plain form a
-- retry fails (`relation already exists`) until the operator runs `DROP INDEX CONCURRENTLY` on it: fail closed.
CREATE UNIQUE INDEX CONCURRENTLY "UQ_idx_erpnext_posting_status_count_chunk" ON erpnext_posting_status (tenant_id, count_session_id, count_chunk) WHERE count_session_id IS NOT NULL;
