-- Rollback of 0125_transfer_leg_unique_idx (RT-1513).
DROP INDEX CONCURRENTLY IF EXISTS "UQ_idx_erpnext_posting_status_transfer_leg";
