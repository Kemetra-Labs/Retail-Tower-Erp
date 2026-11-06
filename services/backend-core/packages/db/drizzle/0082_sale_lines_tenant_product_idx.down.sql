-- 0082_sale_lines_tenant_product_idx.down.sql - reverses 0082_sale_lines_tenant_product_idx.sql (RT-459).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop takes no lock that blocks sale line reads or writes. IF
-- EXISTS so a rollback after a failed (invalid, then manually dropped) build
-- still completes. The Tracking Profile lock probe falls back to reading the
-- tenant's sale lines; no sale line is touched.

DROP INDEX CONCURRENTLY IF EXISTS idx_sale_lines_tenant_product;
