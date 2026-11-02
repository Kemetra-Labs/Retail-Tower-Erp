### Added
- RT-1066 `[GATED: migration 0078]`, approved under the owner delegation of
  2026-11-02 (RT-1064 TH-5 shape): migration `0078_product_stock_levels`
  (tenant default and per-store low-stock levels; `0 < critical <= reorder`
  CHECKs; one active level per scope; same-tenant composite FKs to the
  product and the store; RLS ENABLE + FORCE with SELECT / INSERT / UPDATE
  tenant policies, no DELETE; a down migration that refuses while any level
  is stored), its grants fragment and
  `docs/operations/sql/product-stock-levels-domain-grants.sql`, and the
  runtime of the five `catalog/stock-levels.yaml` operations
  (`consoleGetProductStockLevels`, `consoleSetTenantStockLevel`,
  `consoleRetireTenantStockLevel`, `consoleSetStoreStockLevel`,
  `consoleRetireStoreStockLevel`): CAT-W1 / CAT-W2 roles with the operator
  store scope, a required `Idempotency-Key` on both sets, the
  `expectedUpdatedAt` precondition (409 `stale_write`), 409 `product_retired`,
  422 `critical_above_reorder`, one `audit_events` row per accepted write.
  Only the operations' `x-runtime-status` / `x-runtime-note` markers are
  removed from the contract. Never ERPNext; nothing on the POS read-down.
