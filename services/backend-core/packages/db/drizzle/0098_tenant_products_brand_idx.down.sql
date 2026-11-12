-- 0098_tenant_products_brand_idx.down.sql - reverses 0098_tenant_products_brand_idx.sql (RT-1334).
--
-- One statement, for the same reason as the up file: DROP INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the runner wraps a multi-statement
-- file in one. The drop blocks no read or write of tenant_products. IF EXISTS
-- so a rollback after a failed (invalid, then manually dropped) build, or after
-- 0097's down dropped the column with it, still completes. No product row is
-- touched; the brand filter falls back to the tenant's product scan.

DROP INDEX CONCURRENTLY IF EXISTS idx_tenant_products_tenant_brand;
