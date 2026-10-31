### Added
- RT-1008 `[GATED]`, owner authorization 2026-10-31 (RT-996 decision D-1): contract
  `console-sales-by-store.openapi.yaml` for `consoleGetSalesByStore`
  (`GET /api/v1/sales-by-store`), `x-runtime-status: contract-only`. Every store in the
  caller's scope (at most 500, else 400 `scope_too_large`) over at most 31 business days,
  ranked by received sales in the required `currency`, with share, average sale, best day,
  dense per-day state (`complete` / `so_far` / `not_begun`) and the equal-length previous
  period (`compare`). Audit action `console_sales.by_store_read`; console rate-limit class
  `expensiveRead`. `consoleGetSalesSummary` is unchanged. No runtime, migration or client
  change.
