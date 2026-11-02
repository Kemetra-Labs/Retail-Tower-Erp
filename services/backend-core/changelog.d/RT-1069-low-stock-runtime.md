### Added
- RT-1069: the runtime of `consoleListLowStock`
  (`GET /api/v1/inventory/low-stock`, `inventory/low-stock.yaml`; RT-1055
  LS-1 to LS-5). Session-only owner / tenant_admin / store_manager with the
  operator store scope and the non-disclosing 404; one snapshot statement
  over the evaluated (store, product) pairs, thresholds read from
  `product_stock_levels` and resolved per pair (RT-1064 TH-3: an active store
  level, else the active tenant level); severity order (critical, then the
  exact level ratio, then store, then product), a bounded top-N and the
  scope's counts. A pair with no threshold is never evaluated; an unknown
  on-hand is counted, never listed or shown as zero. No migration or index.
  Only the operation's `x-runtime-status` / `x-runtime-note` markers are
  removed from the contract, and its Posture paragraph rewritten. Never
  ERPNext.
