# RT-1151 — Readiness review and implementation plan

| | |
|---|---|
| **Jira** | RT-1151 (RT-282 PR-04, PR-05, PR-07). Parent RT-1. Blocks RT-1484, RT-1133 |
| **Work Mode of this file** | Docs (readiness review). No code, OpenAPI or migration. RT-1151 itself is Implementation |
| **Baseline** | `origin/main` @ `f30c5de34cfd07f5c0646d01465dca3b8a13677b` (2026-11-19) |
| **Inputs read** | RT-1151 (description, no comments), RT-1150 (c17642), RT-1484/1485/1486/1133, RT-1 c17724; specs [041](spec.md) ([data-model](data-model.md), [decision record](decision-record.md), [plan](plan.md)), [042](../042-price-change-set-lifecycle/plan.md), [043 decision record](../043-pos-offline-price-activation/decision-record.md), [044](../044-pricing-legacy-cutover/plan.md); `services/backend-core/docs/planning/rt-282-pricing-backlog-draft.md` §PR-04/05/07 |
| **Status** | DRAFT for owner review. It authorizes nothing |

## 1. Verdict

**Not ready to start yet. It becomes ready with one owner message that answers D1–D5 below.**

The design is complete enough to build: OD-1..6 and Q-1..8 (spec 041) and Q-B1..8 (spec 042, Q-B2/Q-B3
owner-ratified) cover every table, constraint and payload in scope. What is missing is authorization and four scope
clarifications in the issue text, one of which (D3) is a real conflict between the RT-1151 acceptance criteria and
the RT-282 backlog it implements.

G4-5 (spec 043, restart fail-safe) does **not** block RT-1151, provided D4 is answered as recommended: nothing in
RT-1151 depends on the trusted-clock model.

## 2. Verified facts on `main` (`f30c5de34`)

| # | Fact | Evidence |
|---|---|---|
| V1 | No pricing table, endpoint or contract exists; no `change_set` anywhere. | grep of `packages/db/src`, `apps/api/src`, `packages/contracts/openapi` |
| V2 | The till sends the price; the server never prices a sale. `captureSale` validates the arithmetic of the POS-sent `unitPrice` and stores it. | `apps/api/src/catalog/sales/sale-line-pricing.ts`, `sale-capture-writes.ts:135-149` |
| V3 | `sale_lines.unit_price numeric(19,4) NOT NULL`, no provenance columns. | `packages/db/src/schema/sales/sale-lines.ts:53` |
| V4 | Sale idempotency hashes the whole request body (`sha256CanonicalHex(body)`), so any new optional request field is covered by replay detection without extra work. | `apps/api/src/catalog/sales/sales.service.ts:331,501,650` |
| V5 | `btree_gist` is already installed (migration `0016`), and `EXCLUDE USING gist` is already used (`0101_offer_engine.sql:737`). Spec 041 plan §5 risk "extension unavailable" is closed. | `packages/db/drizzle/0016_inventory_unit_guard.sql:42` |
| V6 | Latest migration is `0120`. The FORCE RLS `DO` block to copy is `0101_offer_engine.sql:933-956`. | `packages/db/drizzle/` |
| V7 | Contracts are self-contained files: no cross-file `$ref` anywhere under `packages/contracts/openapi`. A type shared by two contracts is duplicated and kept equal by a test. | grep |
| V8 | `pos-sales/sales.yaml` is at `1.24.0-draft`. | line 4 |
| V9 | POS read-down validation is hand-written and tolerates extra fields (spec 043 "Evidence for OD-6"). POS pins contracts by blob SHA. | spec 043 decision record |
| V10 | Per-tenant serialization helper exists (`lockPostingFeedSequence`); audit sink `audit_events` exists; grant registry is `apps/api/src/auth/grant-registry.ts` with `docs/operations/sql/*-domain-grants.sql` deploy steps. | `packages/db/src/helpers/posting-feed-lock.ts:29` |

## 3. Owner decisions and blockers

Each item names the smallest decision that unblocks it and the recommendation.

| ID | Blocker | Smallest decision | Recommendation |
|---|---|---|---|
| **D1** | Gate authorization. RT-1151 says "owner authorization is still required for the gated contract and migration before execution". Nothing on the issue grants it. | "RT-1151 authorized: `[GATED: contract]` and `[GATED: migration]` for the slices in §4." Written on RT-1151. | Authorize. After PR-A/B/C merge, reversing any of OD-1..6, Q-1..8 or Q-B1..8 becomes a gated change, so this is also the last cheap point to revisit them. |
| **D2** | RT-1150 is still **In Review**, linked as "blocks" RT-1151. Its answer is posted (c17642) and says "closing as answered by owner approval". | Move RT-1150 to Done (owner reconciles), or remove the block link. | Close RT-1150. Its content is not a technical blocker any more. |
| **D3** | **AC conflict on PR-07.** RT-1151 AC: "Sale capture writes provenance on every new line". RT-282 PR-07: an **optional** request field; "capture stores whichever variant arrives, frozen, and never recomputes it". The server cannot derive provenance (V2): only the till knows which cached price it sold. No POS build sends it until RT-1486 PR-P2. | Reword the AC to: "Capture persists `pricingProvenance` verbatim whenever the line carries it; lines without it store NULL; existing sales unchanged; replay with a different provenance is an idempotency conflict." | Adopt the backlog wording. Server-side stamping of a guessed `legacy` variant would record a belief the till may not have had (it may sell from a cache older than the current catalogue cursor), which breaks spec 043 G4-13 revalidation. |
| **D4** | **PR-07 vs spec 043 G4-11.** G4-11 (approved as selected) adds a per-line `pricingCapture {pricedAt, timeBasisEpoch, stale, clockState}` and a sale-level `pricingContext` to PR-07. `timeBasisEpoch` depends on G4-3 (gated post-pilot target, RT-279 contract unverified) and `clockState` on G4-5 (not ratified). | Confirm that RT-1151 ships only the `pricingProvenance` union, and that `pricingCapture` / `pricingContext` move to RT-1486 (G4a-gated). Spec 044 §7.4 (line 511) also places them in PR-07, so the owner's answer is recorded there by a one-line doc amendment in the PR-D PR. | Defer them. They are additive request fields, so a later add costs one more contract bump of `sales.yaml` and nullable columns. Shipping them now would freeze fields whose meaning is not ratified. |
| **D5** | **Change Set tables.** The RT-1151 scope lists Book, Zone, membership, events and Revision. The backlog PR-05 AC also lists "Change Set and change-set items". `price_events.change_set_id` and `pricing_revisions.change_set_id` need a target, including the system legacy-import change set (spec 044 §4.2, line 148). | Choose: (a) RT-1151 creates the generic `change_sets` header **and** `price_change_set_items` / `price_change_set_lines`; or (b) only the header, items/lines move to RT-1484. | **(a)**, in its own migration file (PR-C2). PR-B already commits the lifecycle and preview payloads to OpenAPI; the tables that hold them belong to the same foundation, and RT-1484 then carries no migration of its own except settings. |

Smaller points that do **not** need the owner, decided here as plan defaults (the owner may override in the same message):

| ID | Point | Plan default |
|---|---|---|
| P1 | Horizon. RT-1151 is `fixVersion = Post-Pilot`. | Starting now is the lead's call (RT-1 chain), not an owner gate. Pilot-critical work keeps priority on CI capacity. |
| P2 | Who may call inquiry. | Console (`cookieAuth`) only in v1. POS receives pricing through the PR-06 stream (RT-1486), never through inquiry. Store Managers read only their stores (`store_access`); no authoring (Q-B2). |
| P3 | Device revision apply-state table (backlog PR-05, second migration). | **Excluded.** It is G4a-gated and shaped by spec 043; it belongs to RT-1486. |
| P4 | `pricing.change_set_approval` setting and `pricing.min_lead_time` (spec 042 §7). | Excluded. RT-1484 (PR-10) owns them with the RT-284 interim. |
| P5 | Migration numbers. | Take the next free number on `origin/main` at the time of the first push of each migration PR (today `0121`), and re-check before every push; a sibling PR that lands first forces a renumber, never a shared number. |
| P6 | Provenance storage on `sale_lines`. | Typed nullable columns plus one `CHECK` for variant consistency, not `jsonb`, so Pricing Health (G4-13) can index and query them. **No FK** to `price_events`: a well-formed provenance is never refused for its content (043 G4-13: mismatches become Health findings, capture never fails). Only a malformed shape (unknown origin, mixed variants) fails request validation, like any other malformed field. |
| P7 | Down migrations. | Refuse to run when a Pricing table holds rows (spec 044 R3). Never drop data. |

## 4. Slices (PRs)

All in `services/backend-core/`. Every PR carries the Official-first short form (§6), a `changelog.d/RT-1151-<slug>.md`
fragment, and runs `reviewing-pull-requests` in a fresh subagent before opening.

| PR | Backlog | Title tag | Content | Depends on | Size (est.) | CI evidence |
|---|---|---|---|---|---|---|
| **PR-A** | PR-04 (inquiry) | `[GATED: contract]` | New `packages/contracts/openapi/pricing/price-inquiry.yaml`: current, `?at=&asOfRevision=`, timeline, explain (spec 041 §4.4, §8). Defines the `PricingProvenance` discriminated union (§5). All operations `x-runtime-status: contract-only` + `x-runtime-note`; one `apps/api/test/console-rate-limit/classes/price-inquiry.rate-limit.yaml`; contract lint/conformance tests. | D1 | ~500 YAML + ~250 test | `required`; CircleCI `api` |
| **PR-B** | PR-04 (authoring) | `[GATED: contract]` | New `pricing/price-structure.yaml` (Book, Zone and membership reads; Book and Zone management per backlog PR-04. Membership changes only through a Change Set `move_store_zone`, spec 042 §4.2) and `pricing/price-change-sets.yaml` (spec 042 §12: create, patch with `expectedVersion`, validate, preview, submit, approve with `previewHash`, reject, publish, rollback, cancel; 409 `stale_validation`, `preview_changed`, `version_conflict`). Emergency follows Q-B3 (independent prior approval). Contract-only markers and rate-limit classes as PR-A. | D1 | ~1 200–1 600 YAML + ~300 test | `required`; CircleCI `api` |
| **PR-C1** | PR-05 (core) | `[GATED: migration]` | `price_books`, `price_zones`, `price_zone_memberships`, `pricing_revisions`, `pricing_revision_stores`, `price_events`, generic `change_sets` header (spec 041 data-model §2.1–§2.6; spec 042 §4.1, §9). Exclusion constraints (btree_gist), scope/time-basis checks, single-Book and single-default-Zone partial unique indexes, immutability triggers, no `DELETE` grant, FORCE RLS loop (V6), Drizzle schema, grant registry + `docs/operations/sql/pricing-domain-grants.sql`, down refusing on rows (P7). Specs as migration owner (`asMigrationOwner`, empty GUC case): overlap rejected, immutability, RLS matrix, up/down. | D1, D5 | ~700 SQL + ~350 TS schema + ~900 test | `required`; CircleCI `db-package` (or Depot for uncommitted db work, per-run owner authorization) |
| **PR-C2** | PR-05 (change-set content) | `[GATED: migration]` | `price_change_set_items`, `price_change_set_lines` (spec 042 §4.2–§4.3, §10: lines immutable after publish, referenced from audit). Only if D5 = (a). | PR-C1 merged (FK + number) | ~250 SQL + ~150 TS + ~350 test | as PR-C1 |
| **PR-D** | PR-07 | `[GATED: contract, migration]` | `pos-sales/sales.yaml` → `1.25.0-draft`: optional request `lines[].pricingProvenance` (union of §5, identical to PR-A, guarded by an equality test). Not echoed in POS-facing responses (same rule spec 044 §7.4 sets for `pricingCapture`/`pricingContext`; it avoids a POS re-pin before PR-P2). Migration: nullable typed columns on `sale_lines` + variant `CHECK` (P6); no backfill (metadata-only `ADD COLUMN` on PostgreSQL 16). Capture writes verbatim; tests: with/without provenance, each variant, invalid or mixed variant rejected with 400 `ValidationFailure`, replay with a different provenance is a conflict (V4), existing rows untouched. Grep `apps/api/test` for `1.24.0-draft` before push. | D1, D3, D4; PR-A merged (union source of truth) | ~120 YAML + ~60 SQL + ~250 TS + ~400 test | `required`; CircleCI `api` and `db-package` |

### Order and parallelism

```
D1–D5 answered
  ├─ PR-A  (contract, inquiry + union) ──────────────┐
  ├─ PR-B  (contract, structure + change sets)       ├─> RT-1484 can start (needs A, B, C1, C2)
  └─ PR-C1 (migration, core) ─> PR-C2 (migration) ───┘
PR-A merged ─> PR-D (sale-line provenance) ─> RT-1486 PR-P2 later
```

- **PR-A, PR-B and PR-C1 run in parallel.** They touch disjoint files. Enum spellings (`book|zone|store`,
  `store_local|absolute`, `regular`, revision `kind`) come from spec 041 data-model and must match; the PR-C1 review
  checks them against PR-A/PR-B.
- RT-1151's AC "contract PR merged first" is met by merging PR-A and PR-B before PR-C1. PR-C1 can be developed and
  preflighted in parallel and simply merge third.
- **PR-D waits for PR-A** only so the union has one source of truth. It is independent of PR-C1/C2 (no FK), so
  it does not wait for the schema.
- PR-C2 and PR-D both add migrations: whichever is second takes the next number (P5).
- **Consumer repins:** none for PR-A/B/C (new files; no consumer pins them yet). PR-D changes a POS-pinned
  contract: `contracts/check` goes red for the POS pin on `main` until a follow-up POS repin PR (out of RT-1151 scope;
  name the owner on the PR — RT-1486 PR-P2, or a small repin issue).
- RT-1133 (Console) needs PR-A, PR-B and RT-1484 runtime; nothing here unblocks it alone.

Estimated total: five PRs, about 4 500–6 000 changed lines, most of them YAML and tests.

## 5. The provenance union (frozen here so PR-A and PR-D agree)

From RT-282 PR-06/PR-07 and spec 041 §4.4. Field names are the contract names.

```jsonc
// origin = pricing (emitted after cutover, RT-1485)
{ "origin": "pricing", "sourceScope": "book|zone|store", "priceEventId": "<uuid>",
  "priceKind": "regular", "pricingRevision": 418 }
// origin = legacy (pre-cutover legacy path, PR-11)
{ "origin": "legacy", "sourceScope": "legacy_tenant|legacy_store", "catalogCursor": "<read-down cursor>" }
```

- `priceKind` is `regular` only in v1 (OD-1); `clearance`, `open`, `manual-override` (backlog spelling; final enum spelling chosen in PR-A) stay reserved in the description
  (backlog PR-07 lists them; adding an enum value later is additive for the server, and POS validation is lenient, V9).
- `pricingRevision` is the **store revision the device applied** (spec 043 G4-11 A), not the revision that published
  the event.
- No tax fields (G3, spec 041 §7).
- `sale_lines` columns (P6): `pricing_origin`, `pricing_source_scope`, `price_event_id`, `price_kind`,
  `pricing_revision`, `pricing_catalog_cursor`; `CHECK` that the set of non-null columns matches exactly one variant or
  is all NULL.

## 6. Official-first short form (for RT-1151 and each PR body)

```
Official capability / docs + version: ERPNext Price List / Pricing Rule reviewed and excluded by owner-approved
  decisions 461–463, 506, 589 and CR06 (ERPNext is never price authority; Connector posts with
  ignore_pricing_rule=1; decision numbers as cited on RT-1151). PostgreSQL 16 native: btree_gist exclusion constraints (REUSE, migration 0016).
Existing Retail Tower implementation: none for pricing (V1). Reused: FORCE RLS loop (0101), audit_events,
  lockPostingFeedSequence, payload_hash idempotency, contract-only markers, grant registry.
Decision: BUILD (Backend-Core Pricing, approved architecture: Backend-Core owns retail operational logic)
Why: no native or existing component provides effective-dated Book/Zone/Store pricing with revisions;
  ERPNext is excluded as authority by decision.
Safety: additive only; legacy price columns and readers untouched; FORCE RLS on every new table; no ERPNext
  write; a well-formed provenance never makes capture fail; down migrations refuse when tables hold rows.
```

## 7. Not in RT-1151 (owners)

Resolver, authoring runtime, Change Set lifecycle, approval settings, `price_history` writes → **RT-1484**.
Legacy import, read-down projection, dual-read, cutover → **RT-1485**. Device apply-state table, `pricingCapture`,
`pricingContext`, POS consumption → **RT-1486** (G4a). Console → **RT-1133**. Fiscal/tax → RT-294.

## 8. Risks

- **POS repin after PR-D.** `contracts/check` reports the POS pin as stale until repinned; plan the repin with PR-D.
- **Union drift.** Two copies (PR-A, PR-D, later PR-06 read-down) by V7. Mitigation: one equality test per copy.
- **Zone-change semantics (Q-3, G4-3)** stay a known v1 limitation for `store_local` history; nothing in RT-1151
  makes it worse.
- **Large PR-B.** If review time is a problem, split it into structure and change sets; the slices are independent.
