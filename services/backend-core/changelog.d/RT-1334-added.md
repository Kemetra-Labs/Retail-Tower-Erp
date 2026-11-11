### Added
- RT-1334 `[GATED: contract, migration]`, owner authorization relayed from the RT-286
  coordinating session (2026-11-11): product Brand in the Tenant Catalog (RT-286 spec 048
  slice S1), so offers can target a brand. Migration `0095_tenant_product_brands` adds the
  flat, tenant-owned `tenant_product_brands` (FORCE ROW LEVEL SECURITY, SELECT / INSERT /
  UPDATE tenant policies and no DELETE policy, active names unique per tenant) and a
  nullable `tenant_products.brand_id` whose composite same-tenant FK clears only `brand_id`
  when a brand is deleted (`ON DELETE SET NULL (brand_id)`). `catalog/console-catalog.yaml`
  `1.2.0-draft` (additive; oasdiff INFO only) adds `consoleListCatalogBrands`,
  `consoleCreateCatalogBrand` (`Idempotency-Key`) and `consoleRenameCatalogBrand`
  (`expectedUpdatedAt`), `brandId` / `brandName` on the product summary, `brandId` on the
  product create and update (422 `brand_unavailable`), and the `brand_id` list filter; the
  runtime serves them, audited as `catalog.brand.create` / `catalog.brand.rename`. Adds the
  `tenant-product-brands-domain-grants.sql` deploy script (domain role: SELECT, INSERT and
  UPDATE on `name` only) and its grant fragment, and a down migration that refuses while
  any brand exists. The POS read-down is unchanged (OD-6): a brand change writes no
  `catalog_change_log` row. No Admin-Console change (S6).
