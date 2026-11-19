### Added
- RT-1151 `[GATED]`, owner authorization on RT-1151 (D1, D3, D4, 2026-11-19): sale-line pricing
  provenance (RT-282 PR-07). `pos-sales/sales.yaml` 1.25.0-draft: a captured line may carry
  `pricingProvenance`, the `PricingProvenance` union shared with `pricing/price-inquiry.yaml`
  (`origin: pricing` with source scope, price event, price kind and the Store revision the till
  applied; or `origin: legacy` with the legacy scope and catalogue cursor). Capture stores it
  verbatim in `sale_line_pricing_provenance` (migration 0122, append-only, FORCE RLS), never
  recomputes it and never refuses a sale over it; a line without it stores nothing. Not echoed in
  responses until a re-pinned POS accepts it.
