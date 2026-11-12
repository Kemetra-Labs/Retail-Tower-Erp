-- 0102_sale_tenders_redemption_idx.down.sql - reverses 0102_sale_tenders_redemption_idx.sql (RT-1114).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop blocks no read or write of sale_tenders. IF EXISTS so a
-- rollback after a failed (invalid, then manually dropped) build, or after
-- 0099's down dropped the column with it, still completes. No tender row is
-- touched; capture's own check under the redemption row lock still refuses a
-- redemption that already pays a tender.

DROP INDEX CONCURRENTLY IF EXISTS uq_sale_tenders_tenant_redemption;
