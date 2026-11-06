### Added
- RT-459 `[GATED]`, owner authorization 2026-11-06 (RT-459 comment 15729;
  applying to the lab or a live database is not authorized): the two indexes
  behind the Tracking Profile lock probe (decision 387, RT-448). Migration 0082
  builds `idx_sale_lines_tenant_product` and 0083 builds
  `idx_stock_movements_tenant_product`, both `(tenant_id, tenant_product_ref)
  WHERE tenant_product_ref IS NOT NULL`, each with `CREATE INDEX CONCURRENTLY`
  as a single-statement file so the runner does not wrap it in a transaction
  and no write is blocked. RLS supplies the tenant equality, so the probe in
  the profile GET/PUT and the 0045 trigger now reads a few index entries
  instead of every sale line and movement of the tenant. Additive only; no
  runtime, rule or contract change.
