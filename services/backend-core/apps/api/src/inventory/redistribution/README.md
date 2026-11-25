# Redistribution proposals: engine and validator (W9, RT-1598)

**Owner: W9 (RT-1594), not W3.** This code sits under `inventory/` because the `stock` tier and the W3 ports
it will consume live here (RT-1595 D-5; RT-1596 master plan §2.2). W3 keeps the data, the ATS formula, the
snapshot and the transfer command; nothing here changes them.

Stage 1 of slice A, "redistribution proposals" ([master plan](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/93913090),
§3.1, §4, §10.1). This is a pure TypeScript module: no I/O, no database, no HTTP, no framework, no dependency.
`test/inventory/redistribution/purity.unit.spec.ts` enforces that.

| File | Role |
|---|---|
| `types.ts` | `RedistributionProblemV1`, `RedistributionResultV1` and their parts (internal types; RT-1599 owns the API contract) |
| `policy.ts` | Shared policy values: rule name and version, `TRANSFER_LINE_MAX`, `SOURCE_FLOOR_INCLUSIVE`, the default buffer and limits |
| `quantity.ts` | Exact `numeric(19,4)` parse and format as scaled bigints |
| `engine/` | Input checks and the rule `reorder_gap_greedy` |
| `validator/` | The independent validator, on a separate code path that never imports `engine/` |
| `propose.ts` | `proposeRedistribution`: engine, then validator, then the result |

## Rule `reorder_gap_greedy` (P-1, P-9, P-10)

Per store × product, in exact decimals:

- `buffer = max(1 stocking unit, 10% of reorderLevel)`, rounded **up**. The rounding is at the 0.0001 scale, or to a whole unit when `rounding: "whole_unit"`. This is a P-10 placeholder and a parameter (`problem.buffer`).
- `surplus = max(0, ATS − reorderLevel − buffer − openOutboundDraft)`.
- `deficit = max(0, reorderLevel − ATS − openInbound)`.

Products are processed by product id. For each product, the largest deficit goes first. It is served from a store pair already chosen, if that pair has surplus; otherwise from the largest surplus. Ties break on store id.

A (source, destination) pair carries at most `maxLinesPerTransfer` lines (≤ 100, W3's limit). Beyond that, another source is used.

The objective is lexicographic: residual deficit, then store pairs, then lines. No optimality claim is made, and there is no solver (D-4).

The warning `source_near_reorder_level` goes on every line whose source ends at or below `reorderLevel + 2 × buffer`.

## Statuses

| Status | Meaning |
|---|---|
| `proposed` / `nothing_to_move` | Validated plan, with or without lines |
| `refused_too_large` | Stores or rows above the caps, checked before any compute |
| `deadline_exceeded` | Clock past `deadlineMs`. It is checked per product, every 1024 steps and after validation |
| `invalid` | Malformed input, a validator violation, or an objective the validator does not reproduce |

Every status other than `proposed` has no moves. There is never a partial result.

## Deviations from the §3.1 sketch (for RT-1599 to ratify)

- `stores[].tenantId`, so the validator can check "same tenant".
- `rows[].tracked`, so tracked products are skipped explicitly instead of relying on the caller.
- `rows[].reorderLevel` may be `null`. Such a row is skipped and counted in a `reorder_level_missing` warning.
- `problem.buffer`: the P-10 buffer policy as a parameter.
- `moves[].warnings`: per-line `source_near_reorder_level`.
- `warnings` and `validator.violations` are structured `{ code, … }` objects, not strings. Row-level warnings are counted per store.
- `objective` and `validator` are `null` when nothing was computed.
- Stores excluded as `inactive` are neither source nor destination. Any other exclusion only bars the store as a source.

## Open owner question

The floor is inclusive: a source may end at exactly `reorderLevel + buffer`, which is where P-10's surplus formula leaves a fully used source. P-10's text "rejects at or below" would make that strict. Flipping `SOURCE_FLOOR_INCLUSIVE` makes both the engine and the validator strict, because both read that one constant.
