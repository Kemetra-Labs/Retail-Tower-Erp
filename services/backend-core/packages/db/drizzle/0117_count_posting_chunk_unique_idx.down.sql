-- Rollback of 0117_count_posting_chunk_unique_idx (RT-1423): drop the unique chunk key. Additive index; no data is lost.
DROP INDEX CONCURRENTLY IF EXISTS "UQ_idx_erpnext_posting_status_count_chunk";
