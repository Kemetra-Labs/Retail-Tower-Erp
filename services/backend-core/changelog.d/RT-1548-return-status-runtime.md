### Added
- RT-1548 `[GATED: contract]` (the runtime lift of the contract-only marker),
  slice 2 of 2: the runtime of `readReturnStatusByProvenance`
  (`GET /api/pos/v1/sales/{saleRef}/returns/by-provenance/status`). It answers
  `recorded` (the `recordReturn` `SaleReturn` projection and `creditLinked`,
  true for a credit-sale reversal, whose zero-cash-refund projection has an
  empty `refundTenders`) or `not_recorded`, looked up among the returns of THIS
  sale only. The decision order is the contract's: the returns gate, the sale in
  the caller's (tenant, store) scope, then the key; a gate that is off, a sale
  out of scope and a malformed sale ref are one non-disclosing 404 and never
  `not_recorded`. Each authorized 200 audits one ref-only `pos_sales.return_read`
  event (the sale ref, plus the return ref when recorded). No migration, no
  schema, field or status change; only the `x-runtime-status: contract-only`
  marker is dropped. The read sits behind `POS_RETURNS_ENABLED` and a second,
  default-off rollout gate, `POS_RETURN_STATUS_READ_ENABLED`: leave it off until
  every instance that serves `recordReturn` runs this bound and the database's
  `synchronous_commit` and replica setting is verified
  (`docs/operations/return-commit-bound.md`: NOT VERIFIED for the lab and
  production from the repo). `docker-compose.prod.yml` and `deploy/prod.env.example`
  pass the flag, `false` by default (`test/deploy/compose-api-env.spec.ts` requires
  every API env name to be mapped).
- RT-1548 (BR-7): `recordReturn` now issues no COMMIT later than 60 seconds
  (`RETURN_COMMIT_BUDGET_MS`) after it received the request. The clock starts at
  receipt (a middleware stamp before every guard) and so includes the idempotency
  claim, the pool wait and the wait for the sale row lock. Before every
  statement the transaction sets `statement_timeout` and `lock_timeout` to the
  budget left (PostgreSQL 16 has no `transaction_timeout`), and a deadline check
  right before COMMIT rolls back a request that ran out. Such a request answers
  the existing `SystemFailure` (500) and records nothing; a retry re-runs it. The
  replay and idempotency bytes are unchanged. `runWithTenantContext` gains an
  optional, additive `beforeCommit` hook for this check.
