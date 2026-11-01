### Added
- RT-1053: runtime for `consoleGetSalesByStore` (`GET /api/v1/sales-by-store`, contract
  RT-1008). Every store in the caller's console scope (inactive and soft-deleted stores of a
  tenant-wide scope included; more than 500 is 400 `scope_too_large`) over at most 31
  business days, ranked by received sales in the required `currency`, with per-currency
  facts, exact half-even share / average sale / delta, best day, dense per-day state and the
  equal-length previous period (`compare`, default `previous_period`). Same guards, store
  scope, business-date and timezone rules as `consoleGetSalesSummary`; one read snapshot;
  audit `console_sales.by_store_read` (registered as a read action); console rate-limit
  class `expensiveRead`. `[GATED]` (RT-1053): only the operation's `contract-only` marker is
  removed from `console-sales-by-store.openapi.yaml`. No migration or client change.
