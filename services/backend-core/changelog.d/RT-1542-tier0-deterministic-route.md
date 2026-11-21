### Added
- RT-1542 (RT-641 foundation, RT-1527 D-1R): the AI Gateway gains a deterministic Tier-0
  route, `deterministic_no_model`, with zero-cost request-unit settlement. A feature may
  now be registered as a `tier: "deterministic_no_model"` feature carrying a pure,
  synchronous `execute(evidencePack, input)` instead of a prompt and a provider route. It
  runs after authorize, kill switch, entitlement, budget pre-check, the quota reservation
  and the evidence build, and its output is validated by the same strict schema and
  evidence-ref check as model output. A validated run commits one request unit
  (`committed`/`ok`, `route_key = deterministic_no_model`, provider, model, tokens and cost
  NULL); invalid output, an executor throw or an evidence failure releases. No provider is
  requested, there is no automatic escalation and no retry. The budget port input gains a
  gateway-set `providerCost: "zero"` marker, so `FailClosedAiBudget` still denies every
  model route but passes a zero-cost Tier-0 run; the quota can still deny. The reserved
  route key cannot be a model route, and a model feature cannot name it. Model-route
  behaviour is unchanged. `AiModule` stays inert (no features, empty allowlist, disabled
  provider, kill switch off, not imported by `AppModule`, no controller). No migration,
  OpenAPI, dependency or ledger-column change.
