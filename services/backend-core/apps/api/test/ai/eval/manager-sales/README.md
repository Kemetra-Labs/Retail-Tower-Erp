# Manager Sales Ask/Explain synthetic evaluation suite (`msx-eval/2`)

Jira RT-1540 (W8 P-07): the versioned synthetic dataset, its contract spec, the
safety-gate map, the **replay runner** that drives every case through the real
P-06 runtime (RT-1539), and the reviewer and machine-readable reports. Cases are
the 38 rows of RT-1526 v6 section 6, validated against the P-05 contract
`packages/contracts/openapi/ai-manager-sales-explain.openapi.yaml` (RT-1538).
It follows the E1 harness in `../e1/` (a pinned dataset hash, hand-written gold
labels, a golden report) and the P-06 route harness
(`../../manager-sales/msx-route.http.spec.ts`); it adds no framework and no dependency.

| File | Role |
| --- | --- |
| `msx.world.ts` | Synthetic tenants, stores and hand-written figure literals |
| `msx.pack.ts`, `msx.answers.ts` | Place literal figures into the expected answer bodies and their evidence packs (never compute a number) |
| `msx.cases.ts` | The 38 cases: request, caller, language, evidence, expected outcome, effects, gates |
| `msx.schema.ts` | Ajv validators built from the P-05 contract, plus the 31-day span rule |
| `msx.canonical.ts` | Dataset hash pinned in the contract spec |
| `msx.replay.world.ts` | The fact rows the replay serves to the real sales assemblers, written from `msx.world.ts` |
| `msx.replay.rig.ts` | The route harness with recording ports (see below) |
| `msx.replay.ts`, `msx.replay.types.ts` | The runner and scorer: outcome, effects and gates G-S1 to G-S6 per case |
| `msx.report.ts`, `msx.ambiguities.ts` | Reviewer and machine-readable report generators and the list of interpretations and alignments |
| `msx-dataset.contract.spec.ts` | Dataset contract spec (counts, schema validity, gate map, leakage, injection, synthetic-only) |
| `msx-replay.spec.ts` | The replay of the 38 cases, idempotency, the currency-less question, and scorer negative controls |
| `msx-report.spec.ts`, `msx-report.golden.md`, `msx-report.golden.json` | Report spec and committed goldens |

## What the replay runs

REAL: `ManagerSalesController`, `RolesGuard`, `NoPlatformAdminGuard`, `ManagerSalesScope`, the request
validation, `AiGateway` with its preflight, `managerSalesFeature` (matcher, renderer, output schema),
`ManagerSalesEvidenceBuilder`, the response mapping and the global exception filter. The sales reads'
own pure assemblers (ranking, four-digit formatting) run over the synthetic fact rows.

SYNTHETIC: the session and tenant-context guards, the membership role lookup, the store-liveness query,
the fact rows, the entitlement and budget ports (recording fakes that capture checks, reservations,
commits and releases) and the audit queue. The no-provider guarantee is `providers: []` (the gateway has no
route and no provider to call) plus the provider-call metric the rig records; a `fetch` spy is an extra
check, not the guarantee (G-S6).

Owner decision RT-1538 comment 18048: a store outside the caller's scope or
unknown in the tenant, and a refused role (platform admin included), is the
non-disclosing HTTP 404 `not_found`. Cases 18, 19 and 36 encode that, not the
200 `unavailable` that section 6 originally expected.

## Run

From `services/backend-core/apps/api`, after `pnpm install --frozen-lockfile --ignore-scripts` and
`pnpm --filter "@data-pulse-2/api^..." build` in `services/backend-core`:

```bash
npx jest test/ai/eval/manager-sales
MIGRATION_TEST_ALLOW_SKIP=1 npx jest test/ai          # the whole AI tree, E1 and manager-sales included
UPDATE_MSX_GOLDEN=1 npx jest test/ai/eval/manager-sales/msx-report   # only for a new dataset version
MSX_REPORT_OUT=<dir> MSX_CODE_SHA=<main sha> MSX_RUN_DATE=<date> npx jest test/ai/eval/manager-sales/msx-report   # writes msx-report.md and .json
```

## Changelog

- `msx-eval/2` (RT-1540 part 2): aligned the dataset's presentation to the P-06 runtime after the
  first replay (RT-1540 comment 18101): bare `COLUMN_COPY` column and slot keys (statement block keys
  keep the `msx.` prefix); a store with a missing or zero-sales ranking figure in a `["store","count"]`
  table; not-begun days in a `["date"]` table; T-07 as two tables (current, then `ss.baseline`) with
  `voids` and `returns` keys; the by-store source added when a summary template covers several stores;
  the citation `fieldPath` strings of the contract's response grammar; case 15 in the read's order;
  case 30 served a world where A2 has no sales; case 32 off G-S3 (it reads and reserves by design);
  G-S1 scored on every case. Review round 1: case 11 now has caller OA (two of three stores, a strict
  subset) with the `scope_relative_ratio` notice and the G-1 and G-2 gaps; each summary read has its own
  `asOf` (the baseline read keeps the later instant). Added received-zero lines: cases 29, 16 and 17
  state the read's explicit zero for a currency or a day a store has no facts in. T-10 has no rank or
  share column, so its zero row is complete and inline; the ranking templates move a store with no rank
  to the `["store","count"]` table. Whether a zero needs a UX marker is the open item UX-13.23. No
  scope, charge or refusal code changed.
- `msx-eval/1` (RT-1540 part 1): the 38-case dataset, contract spec and report.
