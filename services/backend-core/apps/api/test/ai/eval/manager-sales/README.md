# Manager Sales Ask/Explain synthetic evaluation suite (`msx-eval/1`)

Jira RT-1540 (W8 P-07), part 1: the versioned synthetic dataset, its contract
spec, the safety-gate map and the reviewer report. Cases are the 38 rows of
RT-1526 v6 section 6, validated against the P-05 contract
`packages/contracts/openapi/ai-manager-sales-explain.openapi.yaml` (RT-1538).
It follows the E1 harness in `../e1/` (a pinned dataset hash, hand-written gold
labels, a golden report) and adds no framework and no dependency.

| File | Role |
| --- | --- |
| `msx.world.ts` | Synthetic tenants, stores and hand-written figure literals |
| `msx.pack.ts`, `msx.answers.ts` | Place literal figures into the expected answer bodies and their evidence packs (never compute a number) |
| `msx.cases.ts` | The 38 cases: request, caller, language, evidence, expected outcome, effects, gates |
| `msx.schema.ts` | Ajv validators built from the P-05 contract, plus the 31-day span rule |
| `msx.canonical.ts` | Dataset hash pinned in the contract spec |
| `msx.report.ts`, `msx.ambiguities.ts` | Reviewer report generator and the list of section 6 interpretations |
| `msx-dataset.contract.spec.ts` | Dataset contract spec (counts, schema validity, gate map, leakage, injection, synthetic-only) |
| `msx-report.spec.ts`, `msx-report.golden.md` | Report spec and committed golden |

Owner decision RT-1538 comment 18048: a store outside the caller's scope or
unknown in the tenant, and a refused role (platform admin included), is the
non-disclosing HTTP 404 `not_found`. Cases 18, 19 and 36 encode that, not the
200 `unavailable` that section 6 originally expected.

## Run

From `services/backend-core/apps/api`, after `pnpm install --frozen-lockfile --ignore-scripts` and
`pnpm --filter "@data-pulse-2/api^..." build` in `services/backend-core`:

```bash
npx jest test/ai/eval/manager-sales
UPDATE_MSX_GOLDEN=1 npx jest test/ai/eval/manager-sales/msx-report   # only for a new dataset version
```

## Remaining runtime dependency (not in this PR)

This part runs nothing against the feature. The **replay runner** that executes
the cases through the Manager Sales Ask/Explain runtime and scores gates G-S1 to
G-S6 on a live path needs P-06 (RT-1539), which does not exist yet and is blocked
by RT-1542. Until then the gates are only mapped to cases and the expected
outcomes are validated against the contract. No skipped or `todo` test stands in
for the runner.
