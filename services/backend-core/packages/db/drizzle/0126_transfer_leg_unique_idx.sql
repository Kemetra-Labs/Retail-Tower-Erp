-- 0126_transfer_leg_unique_idx — Jira RT-1513 (follows 0125): the unique key of a transfer leg work item,
-- UNIQUE (tenant, external_id) over the two transfer kinds. `external_id` is the leg-level provenance key
-- (`transfer_dispatch:<transferId>` or `transfer_receipt:<receiptId>`, decisions 888 and 889), so this is the database
-- backstop of replay-safe emission: a leg can exist once. Partial: sale, reversal and count rows stay out of it. A
-- dedicated single-statement CONCURRENTLY migration (precedents 0036, 0048, 0117), so building it never blocks the
-- posting feed's writes.
-- Deliberately NO `IF NOT EXISTS` (see 0117): an interrupted build can leave an INVALID index of this name, and a retry
-- that skipped it would be recorded as applied while `ON CONFLICT` cannot use an invalid index. With the plain form a
-- retry fails until the operator runs `DROP INDEX CONCURRENTLY` on it: fail closed.
CREATE UNIQUE INDEX CONCURRENTLY "UQ_idx_erpnext_posting_status_transfer_leg" ON erpnext_posting_status (tenant_id, external_id) WHERE kind IN ('transfer_dispatch', 'transfer_receive');
