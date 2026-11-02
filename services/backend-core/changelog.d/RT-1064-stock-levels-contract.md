### Added
- RT-1064 `[GATED]`, decisions TH-1 to TH-5 selected under the owner delegation
  of 2026-11-02 (recommended options): contract-only draft
  `catalog/stock-levels.yaml` (`1.0.0-draft`), the console read and writes of
  a product's low-stock thresholds (`reorderLevel`, optional `criticalLevel`,
  `0 < critical <= reorder`): `consoleGetProductStockLevels`,
  `consoleSetTenantStockLevel`, `consoleRetireTenantStockLevel`,
  `consoleSetStoreStockLevel`, `consoleRetireStoreStockLevel`
  (`/api/v1/catalog/products/{productId}/stock-levels[/stores/{storeId}]`).
  Both sets require an `Idempotency-Key`. Tenant default plus store level,
  resolved as a pair; stored in a dedicated
  `product_stock_levels` table (shape only), not on `store_product_overrides`
  (pricing OD-5 split). Never ERPNext. Decision record
  `docs/planning/rt-1064-low-stock-thresholds.md`. No runtime, no migration.
