-- 0100_sale_lines_promotion_key_idx.down.sql - reverses 0100_sale_lines_promotion_key_idx.sql (RT-1336).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop blocks no read or write of sale_lines. IF EXISTS so a
-- rollback after a failed (invalid, then manually dropped) build still
-- completes. Roll 0101 back first: while `sale_line_promotions` exists its FK
-- depends on this index and the drop is refused. No sale line is touched.

DROP INDEX CONCURRENTLY IF EXISTS uq_sale_lines_id_sale_tenant_store;
