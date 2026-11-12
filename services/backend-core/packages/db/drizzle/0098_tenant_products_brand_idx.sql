-- 0098_tenant_products_brand_idx.sql
--
-- The brand index of `tenant_products` (Jira RT-1334, RT-286 spec 048 slice
-- S1). [GATED: migration], the same authorization as 0097 (RT-1334 comment
-- 16663). Depends on 0097 (`tenant_products.brand_id`).
--
-- Serves:
--   - the Console product list's `brand_id` filter (`tp.tenant_id = $1 AND
--     tp.brand_id = $10`), and the brand eligibility sets Offer Engine S3 will
--     read;
--   - the ON DELETE SET NULL (brand_id) action of 0097's composite FK, which
--     looks up `WHERE tenant_id = $1 AND brand_id = $2`: an equality on
--     brand_id implies brand_id IS NOT NULL, so the partial index serves it.
--
-- Partial (`brand_id IS NOT NULL`): products without a brand are not indexed.
--
-- One statement, CONCURRENTLY (the 0064 / 0085 pattern; landing-gated-changes
-- "an index on a hot table"): `tenant_products` is read by the POS read-down
-- and the Console, and the runner sends each file as one query, wrapping a
-- multi-statement file in a transaction block that CREATE INDEX CONCURRENTLY
-- refuses. The build takes SHARE UPDATE EXCLUSIVE, which blocks no read or
-- write. If a build fails it leaves an INVALID index: drop it with the down
-- file and re-run. No IF NOT EXISTS: an invalid leftover must fail loudly,
-- never be skipped.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): an index only; no new data.
--
-- Reversible via 0098_tenant_products_brand_idx.down.sql.

CREATE INDEX CONCURRENTLY idx_tenant_products_tenant_brand
  ON tenant_products (tenant_id, brand_id)
  WHERE brand_id IS NOT NULL;
