### Added
- RT-1539 `[GATED: contract]` (W8 P-06): the Manager Sales Ask/Explain runtime, `POST /api/v1/ai/manager-sales/explain`
  (`consoleExplainSales`, the RT-1538 contract). A deterministic, routing-tier-0 answer (no model, no provider) to the
  catalogue questions T-01 to T-10 and T-12 over the caller's own sales figures, from the two console sales reads read in
  process, or a typed refusal, or a typed gateway `unavailable`. One AI request-quota unit at zero cost per answer; one
  `ai.manager_sales.explain` audit event per answer. The AI Gateway gains an optional Tier-0 `preflight` (a product
  decline after the kill switch and entitlement, before budget and reservation) and a `declined` result. The contract
  drops its `x-runtime-status: contract-only` marker. No migration: the production plan catalogue `core@1` grants no AI
  feature, so the route answers `not_entitled` until a later gated migration grants `ai.manager_sales.ask_explain`.
  After a 5xx the client must mint a new Idempotency-Key: the failed run's reservation is released, but its key is
  spent. The store scope is role-aware as on the sales reads (owner and tenant_admin are not narrowed by the active
  store); the kill switch is checked before the scope 404; every table row holds exactly as many cells as its header.
