### Added
- RT-1538 `[GATED: OpenAPI]`, W8 P-05 (RT-1526 v6, owner decision on RT-1538
  comment 18048): contract-only OpenAPI `ai-manager-sales-explain.openapi.yaml`
  (1.0.0-draft). `consoleExplainSales` (`POST /api/v1/ai/manager-sales/explain`)
  is the read-only, deterministic, tier-0 Manager Sales Ask/Explain boundary: a
  strict request (`templateId` and/or `question`, `storeIds`, `from`/`to`,
  `currency`, `compare`, `locale`, required `Idempotency-Key`) and a `kind`
  union of `answer`, `refusal` (W8 answer codes) and `unavailable` (existing
  RT-641 reasons only). A store outside the caller's scope or unknown in the
  tenant, a role outside the list and a platform admin are the same
  non-disclosing 404, never narrowed. No runtime, route, ledger outcome,
  migration or consumer change.
