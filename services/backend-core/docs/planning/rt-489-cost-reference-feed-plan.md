# RT-489 — Cost Reference snapshot feed and margin estimate: plan

> **Status:** draft plan (Work Mode: **Planning**, RT-282 PR-14P). **Jira holds the live status.** This file
> records the 2026-11-06 planning pass and is not a status tracker. Nothing here is ratified: §10 lists the
> owner decisions this plan needs.
>
> No production code, OpenAPI, migration, package or CI change. Contract and table shapes below are
> **drafts**. Each one is applied only by the `[GATED]` item named in §9, under that item's own approval.
>
> **Scope authorization:** the owner authorized Backend-Core + ERPNext-Connector planning for this issue on
> 2026-11-06 (CLAUDE.md §8). This plan reads both products and changes neither.
>
> **Sources:**
> - Jira RT-489 (this item), RT-282 (decomposition), RT-483 (PR-01, Done), and RT-284 (Policy engine, Done:
>   plan c11873, ratified c11887).
> - Confluence RETAIL 23855106 "Pricing & Store Overrides Product Architecture": decisions 469, 573–589,
>   649–687 and 688–694 read in full.
> - Monorepo `Kemetra-Labs/Retail-Tower-Erp` `origin/main` **`19f8cca4`**, read-only.
>
> **Baseline note:** the RT-489 description names baseline `ddae78a7` and repo `Kemetra/Backend-Core`. Both are
> out of date: the products have lived in this monorepo since RT-715. All anchors below were checked on
> `19f8cca4`. No runtime was exercised. The ERPNext field behaviour in §5.3 is **NOT VERIFIED** on the pinned
> ERPNext.

---

## 1. The need and the decisions it serves

Pricing needs a **cost** for each item so it can estimate margin. Margin is used in the Change Set Impact Preview,
in the later cost-based recommendations (PR-18P) and in the later guardrails (RT-284, 583–588). ERPNext owns cost
and valuation (469). Backend-Core holds no cost data today (§2, F-1). This plan defines how a **bounded Cost
Reference snapshot** gets from ERPNext into Backend-Core, and how margin is estimated from it.

| Decision | Text (Confluence 23855106) | Where this plan honours it |
|---|---|---|
| 469 | ERPNext remains financial cost/valuation authority; Pricing consumes bounded cost references only. | §3, §4 |
| 573 | Pricing consumes Cost Reference snapshots rather than live ERP cost calls at sale time. | §3.2, §5 |
| 574–576 | Explicit amount, currency, UOM. | §4.1 |
| 577 | Explicit basis: last purchase, valuation, standard or another approved basis. | §4.1, CR-1 |
| 578 | Source/provenance retained. | §4.1 `provenance` |
| 579–580 | `as_of`; explicit freshness. | §4.1, §4.3 |
| 581 | Margin is an estimate calculated from the declared cost basis. | §6 |
| 582 | Stale cost is never displayed as a current margin fact. | §6.3 |
| 589 | Missing cost never makes ERPNext the selling-price authority. | §3.2, §7 |

**Out of scope** (RT-489 "Out of scope"):

- Guardrail policy (583–588: minimum sell price, maximum change, store band, stale-cost *action*) is owned by
  RT-284. This plan only supplies the inputs it would read (§8.2).
- Below-cost **selling** (587) stays behind Gate 2 (RT-486, PR-G2V).
- Cost-based recommendations (688–694) are PR-18P. This plan is one of its inputs.

## 2. What `main` has today (`19f8cca4`)

| # | Fact | Evidence |
|---|---|---|
| F-1 | Backend-Core stores no cost, valuation or purchase price. RT-282 F10 still holds. | schema grep of `services/backend-core/packages/db/src/schema/` |
| F-2 | Every ERP-facing Backend-Core contract **explicitly excludes valuation and cost.** Stock-view (019) reads quantity only ("NO valuation / cost / price / amount field ANYWHERE on this surface", FR-008 / SC-004). The warehouse map, item map and product reconciliation carry identity only. | `packages/contracts/openapi/erpnext-connector/stock-view.yaml:31-33,725`; `catalog/erpnext-warehouse-map.yaml:17-18`; `catalog/erpnext-item-map.yaml:16`; `catalog/product-reconciliation.yaml:19` |
| F-3 | The Connector's Bin reader is quantity-only by design ("NO valuation/cost field (019 / Principle IX)"). | `integrations/erpnext-connector/retail_tower_erpnext_connector/connector/bin_view/frappe_glue.py:13`, `contracts.py:15` |
| F-4 | **Transport precedent:** 012 / 019 use a pull/report pair. Backend-Core *exposes* a cursor-paginated feed of wanted reads and a report endpoint; the Connector *calls* them, and Backend-Core makes no outbound HTTP. Reports need an `Idempotency-Key`; stale cursors return `snapshot_required`. The Connector pages its own windows (v1.2). | `stock-view.yaml:10-28,74-110`; `bin_view/poller.py`, `worker.py` |
| F-5 | **Identity is already mapped.** `erpnext_item_map` (013) maps ERPNext Item → `tenant_product`. `erpnext_warehouse_map` (014) maps Store → ERPNext warehouse. The Connector reports ERP refs; Backend-Core translates them. | `packages/db/src/schema/catalog/erpnext-item-map.ts`; `stock-view.yaml:37-40` |
| F-6 | **Temporal precedent:** the Connector `readAt` is kept as received and is never a security clock. Backend-Core stamps its own `recordedAt`. | `stock-view.yaml:42-45` |
| F-7 | 014 OQ-1 (signed): the Bin view is recorded run-scoped, **never as a standing mirror**. | `stock-view.yaml:23-25` |
| F-8 | The Connector already maps Backend-Core free-text `unit` → ERPNext UOM through a signed map and fails closed on a miss. | `connector/posting/builder.py:64-71,180-193` |
| F-9 | The Connector has an ERPNext Compatibility Profile (665–674) that checks site configuration and records drift. | `connector/posting/compatibility_profile.py` |
| F-10 | The pinned ERPNext is v16.51.0 (Frappe 16.52.0). | `integrations/erpnext-connector/deploy/erp.Dockerfile:5,10` |
| F-11 | Spec 041 (RT-483): a Price Book has **one currency** and a declared `tax_price_basis` (`inclusive`/`exclusive`). Resolution has no FX (481) and never reads ERPNext (461–463, 506). v1 Sell Unit is `each` (OD-2). | `specs/041-pricing-domain/spec.md` §3, §4, §6, §7 |
| F-12 | The spec 042 Impact Preview (RT-484) has old price, new price and delta per line, and **no cost or margin**. | `specs/042-price-change-set-lifecycle/plan.md` §6 |
| F-13 | RT-284 (ratified): a closed capability catalogue with risk tiers and tenant-wide `policy_version`. None of it is on `main` yet (PE-BC1+ not created). | RT-284 c11873 P-A, P-D, P-E; c11887 |

Consequence: everything in this plan is **greenfield**, and it must **not** be added to stock-view, because
that would break stock-view's no-valuation invariant (F-2). The transport, identity and temporal patterns are
reused (F-4 to F-6).

## 3. Authority and boundaries

### 3.1 Who owns what

```
ERPNext (cost / valuation authority, 469)
   │  read only: the Connector never writes cost, never changes valuation settings (668)
   ▼
ERPNext-Connector: reads the declared basis, translates it into Retail Tower terms, reports a snapshot
   │  pull/report over the Connector API (F-4), Idempotency-Key
   ▼
Backend-Core: records immutable Cost Reference snapshots, computes freshness and margin estimates
   │  Backend-computed reads (696, 704)
   ▼
Admin-Console renders them (695). POS receives no cost (CR-9).
```

- **ERPNext** remains the only cost/valuation authority. A Cost Reference is a *dated reference to* an ERPNext
  value. It is not a Retail Tower cost ledger, and Backend-Core never derives valuation itself.
- **The Connector** reads and translates (649). It makes no commercial decision, fabricates no value (a missing
  value is reported as missing, Connector Principle VI) and never changes ERP settings to get a value (668).
- **Backend-Core** owns the snapshot store, freshness, margin estimation and every consumer read. Cost data stays
  out of the Tenant Catalog. The catalog authority split is unchanged: Backend-Core Tenant Catalog is the
  operational authority, and ERPNext Item is the accounting identity used to *address* the cost (F-5).
- **Admin-Console** only renders Backend-computed values. It never calls ERPNext (CLAUDE.md §4).
- **POS** never calls ERPNext and, in the draft, receives no cost or margin (CR-9).

### 3.2 Hard rules (from the decisions; not open)

1. **No live ERP cost call at sale time (573).** Sale capture, read-down and the price resolver (spec 041 §4)
   never read cost. The feed is asynchronous; it is never in a request path that serves POS.
2. **Cost never feeds the price resolver (589).** Missing, stale or changed cost cannot change a resolved price,
   make an item unpriced, or select an ERPNext price. ERPNext Price Lists stay out of resolution (463, 655).
3. **A margin is always an estimate (581)** and always carries its basis, `as_of` and freshness.
4. **Stale cost is never shown as a current margin fact (582).** §6.3 defines the rule; CR-5 decides the display.
5. **Exact decimals only.** Amounts travel as decimal strings and are computed with decimal arithmetic. No
   floats, as in spec 041 §6 and stock-view.
6. **No FX at scan time (481).** A currency mismatch makes the margin unavailable, unless CR-10 approves an
   authoring-time conversion.

## 4. The Cost Reference snapshot (draft model)

### 4.1 Fields

One snapshot = *ERPNext said item I, at scope S, had cost A per UOM U in currency C on basis B, as of T.*

| Field | Type (draft) | Meaning | Decision |
|---|---|---|---|
| `id` | uuid | Snapshot identity | — |
| `tenant_id` | uuid | RLS scope; from the principal, never from the body | §II |
| `tenant_product_id` | uuid | Retail Tower item, translated by Backend-Core from `erpnextItemRef` through `erpnext_item_map` (F-5) | — |
| `erpnext_item_ref` | text | The ERPNext Item name as reported (kept for provenance) | 578 |
| `scope_kind` | enum `store` \| `company` | What the cost applies to (CR-2) | — |
| `store_id` | uuid, nullable | Set when `scope_kind = store`; resolved from the reported warehouse through `erpnext_warehouse_map` | — |
| `erp_company_ref` | text, nullable | Set when `scope_kind = company` | — |
| `basis` | enum `valuation` \| `last_purchase` \| `standard` | Closed set; a new basis is an additive contract change (CR-1) | 577 |
| `amount` | numeric(19,4), decimal string on the wire | Cost per `uom`; must be ≥ 0 | 574 |
| `currency_code` | ISO 4217 | Currency of `amount` (normally the ERPNext Company currency) | 575 |
| `uom` | text | The ERPNext UOM that `amount` is expressed in (normally the stock UOM) | 576 |
| `as_of` | timestamptz | When the value was true **in ERPNext** (§5.3 gives the source per basis) | 579 |
| `read_at` | timestamptz | When the Connector read it; kept as received; never a security clock (F-6) | §X |
| `recorded_at` | timestamptz | Backend-Core server clock at ingest | §X |
| `provenance` | jsonb (closed shape) | `{ erpSiteId, erpVersion, compatibilityFingerprint, sourceDoctype, sourceDocRef?, valuationMethod?, priceListRef?, connectorVersion, requestRef, attemptRef }` | 578 |
| `content_hash` | text | Hash of the business fields; used for dedupe (§5.4) | — |
| `superseded_by` | uuid, nullable | Set when a newer snapshot replaces this one for the same key | §XII |

The **key** is `(tenant_id, tenant_product_id, scope_kind, store_id | erp_company_ref, basis)`. Rows are
**immutable**. A newer reading inserts a new row and supersedes the previous current row for the key; nothing
is updated in place (Backend-Core constitution §XII, as for price events in spec 041 §3.1).

**Missing values are explicit.** A report entry may say `status: "missing"` with a reason (`no_valuation`,
`no_purchase_history`, `no_standard_cost`, `uom_unmapped`, `item_disabled`). Backend-Core records that as a
"missing" observation for the key, so "ERPNext has no cost" is visible and distinct from "never asked". It is
never a zero (Connector Principle VI).

### 4.2 Why a standing reference, and how it differs from 014 OQ-1

014 OQ-1 forbids a standing **Bin** mirror (F-7). A Cost Reference has to be standing, because a Change Set
preview may run long after the last feed, and 573 forbids fetching cost live. The draft keeps it narrow:

- one current row per key, plus superseded history kept for audit and for "what cost did the preview use" (§6.4);
- no aggregation, valuation maths or stock movement in Backend-Core;
- never used as a sellable or catalog attribute.

Whether this exception to the 014 OQ-1 posture is acceptable, and how long history is kept, is **CR-8**.

### 4.3 Freshness (580)

Freshness is **computed at read time** from `as_of` and Backend-Core's server clock. It is never stored as a
flag, so it cannot go stale itself.

| State | Condition (draft) |
|---|---|
| `fresh` | `now − as_of ≤ fresh_for` |
| `stale` | `fresh_for < now − as_of ≤ expire_after` |
| `expired` | `now − as_of > expire_after`. Treated like missing for margin. |
| `missing` | No current snapshot, or the current observation is a "missing" entry |

`fresh_for` and `expire_after` are per basis. Their values, and whether a tenant may set them, are **CR-4**. If
RT-284 adopts them, they become typed policy entries (P-C inheritance; P-E versioning). A second signal,
`feed_lag = now − read_at`, shows a stopped Connector. It is reported next to freshness, never mixed into it: an
old `as_of` read yesterday is stale cost; a fresh `as_of` read weeks ago means the feed is down.

## 5. The feed: ERPNext → Connector → Backend-Core

### 5.1 Transport (mirrors 019, as a new contract)

A **new** contract document, `packages/contracts/openapi/erpnext-connector/cost-reference.yaml`. It is not an
extension of `stock-view.yaml` (F-2; the home is confirmed by CR-12). Draft operations:

| Operation (draft) | Direction | Content |
|---|---|---|
| `costReferencePullRequests` — `GET /api/connector/v1/erpnext/cost-reference-requests?cursor=` | Connector pulls from Backend-Core | Ordered, idempotent feed of wanted reads: `{ requestRef, scope (store + mapped warehouse, or company), bases[], itemWindow }`, scoped to the principal's tenant(s). Stale cursor → 409 `snapshot_required` |
| `costReferenceReportSnapshot` — `POST …/cost-reference-requests/{requestRef}/snapshot` | Connector reports to Backend-Core | `{ readAt, window?, entries: [ { erpnextItemRef, basis, status: "present" \| "missing", amount?, currencyCode?, uom?, asOf?, reason?, source{…} } ] }`. `Idempotency-Key` required (`^[\x21-\x7E]{16,128}$`); duplicate → 200 `Idempotent-Replayed: true`; same key, different body → 409 `idempotency_key_conflict` |

The draft reuses everything 019 already settled: connector-paged windows (`maxWindows × maxItems`, loud refusal
above the limit), the closed `Error` envelope, a non-disclosing 404 for out-of-scope refs, no `tenant_id` in
bodies, `requestRef` as a path parameter, and strict request bodies (`additionalProperties: false`).

**Deploy order:** Backend-Core first (it accepts reports), then the Connector. This is the same order as
stock-view, because here the Connector sends and Backend-Core validates.

### 5.2 Cadence

- **Scheduled:** Backend-Core issues one request per scope per interval. The interval is **CR-3**.
- **On demand (optional, CR-3):** Backend-Core may issue an *out-of-cycle* request for the items in a Change Set
  when it is validated. This is still asynchronous and feed-based (the preview reads whatever has landed and
  shows its freshness). It is never a live call, and never on the sale path, so 573 holds either way.
- A request also covers items that have a mapped ERPNext Item but no tenant price yet, so cost is there when a
  price is first authored.

### 5.3 What the Connector reads for each basis (**NOT VERIFIED** on ERPNext v16.51.0)

Each row is a hypothesis for the Connector reader spec (C-2, §9) to confirm against the pinned ERPNext, for
example on lab-03.

| Basis | Candidate ERPNext source | `as_of` candidate | Scope | Notes to verify |
|---|---|---|---|---|
| `valuation` | `Bin.valuation_rate` for (Item, mapped warehouse) | posting datetime of the latest Stock Ledger Entry for that (Item, warehouse) | `store` | Per stock UOM, in Company currency; FIFO vs Moving Average changes meaning (record `valuationMethod`); can be 0 or negative after negative stock → report `missing` with a reason, never a 0 cost |
| `last_purchase` | `Item.last_purchase_rate`, or the rate on the latest submitted Purchase Receipt/Invoice line | date of that purchase document | `company` | `Item.last_purchase_rate` may not be per Company; purchase UOM ≠ stock UOM needs `conversion_factor` |
| `standard` | an `Item Price` on a tenant-declared **buying** Price List | `Item Price.valid_from` (or modified time) | `company` | This is **cost**, not selling price: only a *buying* list may be named, so 463/655 are not breached. Which list it is becomes a per-tenant setting (CR-1) |

The Connector reads only, through upgrade-safe Frappe APIs (Connector Principles II and III). It adds no DocType
and no hook to read cost. The Compatibility Profile (F-9) gains capability checks for "valuation method known"
and "Company currency known", so a site where the basis cannot be read reads as unhealthy instead of reporting
silent gaps (666–667).

### 5.4 Idempotency

- **Transport:** each report window has a deterministic key, `costref-<requestRef>-<attemptRef>-w<windowSeq>`,
  which fits the 16–128 rule. A replay returns the recorded acknowledgement.
- **Content:** Backend-Core inserts a new snapshot only when `content_hash` differs from the current row for the
  key, or `as_of` is newer. Re-reading an unchanged ERPNext value does not grow history. `read_at` on the current
  row is refreshed through a separate observation timestamp, which feeds `feed_lag` (§4.3).
- **Ordering:** a report whose `as_of` is **older** than the current row's `as_of` is recorded as an observation
  and does not supersede. Late or out-of-order windows cannot roll cost back.

### 5.5 Tenant and store scoping

- The tenant is always the authenticated Connector principal's scope (019 FR-005). A body never names a tenant.
- Store scope comes only from a Backend-Core-issued request, through the store's active 014 `stock` warehouse
  mapping. A store with no mapping gets no `store`-scope request, and its cost falls back to `company` scope
  only if CR-2 allows that.
- Item translation uses the confirmed 013 map. An unmapped `erpnextItemRef` is counted and reported as a finding
  (like `unknown-items`). It is never auto-created.
- Every new table is `tenant_id` + RLS with composite `(id, tenant_id)` foreign keys, as in spec 041.

## 6. Margin estimate (581–582)

### 6.1 Computation (pure function, Backend-Core)

```
estimateMargin(price: Resolution, cost: CostReference | none, sellUnit, now) -> MarginEstimate
```

1. **Price** is a spec 041 resolution (`priced` only), at the instant being previewed.
2. **Cost** is the current Cost Reference for the item, at the scope chosen by CR-2 and the tenant's declared
   basis (CR-1).
3. **Currency:** `cost.currency_code` must equal the Book currency. If it does not → `unavailable(currency_mismatch)`
   (CR-10).
4. **UOM:** cost per `uom` is converted to cost per Sell Unit. v1 has only `each`, mapped to the Connector's `Nos`
   at a factor of 1. Any other pairing → `unavailable(uom_unconvertible)` until RT-281 (CR-11).
5. **Net price:** if the Book's `tax_price_basis` is `exclusive`, net price = price. If it is `inclusive`, the
   net-of-tax price is a Fiscal derivation (RT-294, Gate 3), which Pricing must not compute (468, 591). CR-6
   decides what happens before G3.
6. **Freshness:** §6.3.
7. **Result**, all decimal: `marginAmount = netPrice − cost`, and `marginPct = marginAmount / netPrice` (on price).
   Markup (`/ cost`) is the alternative definition (CR-7). Results are rounded half-up to 2 decimal places *for
   display only*, and the exact value is kept.

### 6.2 Result shape (draft, not OpenAPI)

```jsonc
// estimate available
{
  "status": "estimated",
  "marginAmount": "35.5000", "marginPct": "28.29",
  "cost": { "amount": "90.0000", "currencyCode": "EGP", "perSellUnit": "each",
            "basis": "valuation", "asOf": "2026-11-05T18:20:00+02:00",
            "freshness": "fresh", "scope": "store", "snapshotId": "0192…" },
  "price": { "netPrice": "125.5000", "taxPriceBasis": "exclusive", "pricingRevision": 418 }
}
// stale: the estimate is either withheld or labelled (CR-5); it is never a plain number
{ "status": "stale", "cost": { "...": "…", "freshness": "stale", "asOf": "…" }, "staleEstimate": { "...": "only if CR-5 allows" } }
// no estimate
{ "status": "unavailable", "reason": "missing_cost" }
// | expired_cost | currency_mismatch | uom_unconvertible | tax_basis_unresolved | price_unpriced
```

### 6.3 Stale cost rule (582)

- `fresh` → `status: estimated`.
- `stale` → `status: stale`. The response never puts a bare `marginPct` at the top level. Whether a *labelled*
  stale estimate (with `asOf`) is returned for display, or withheld, is **CR-5**. Either way, a consumer cannot
  read a stale margin as current.
- `expired` / `missing` → `status: unavailable`.
- What a guardrail *does* with stale cost (warn, require approval, block: 588) is RT-284's policy. This plan only
  makes the `freshness` input available (§8.2).

### 6.4 Where margin appears (consumers)

| Consumer | Use | Contract change (additive) |
|---|---|---|
| Change Set Impact Preview (spec 042 §6) | Per line: `oldMargin`, `newMargin` (§6.2 shapes). Summary: count of lines below a margin floor, count with `unavailable`/`stale` cost | PR-04 payload gains optional fields. The preview stores the `snapshotId`s it used, so `previewHash` stays reproducible |
| Price inquiry / explain (spec 041 §8) | Optional `margin` block, behind the cost capability (§8.1) | PR-04 inquiry contract, additive |
| Cost reference console read | List/filter cost references, freshness and feed lag per store (Pricing Health, 704) | New Backend-Core read (C-6) |
| PR-18P recommendations | Cost-based recommendation input (688), keeping the snapshot as provenance (694) | PR-18P's own contract |
| RT-284 guardrails | Inputs `cost`, `freshness`, `marginPct` for 583/587/588 | RT-284 PE items |
| POS | **None** (CR-9) | — |

## 7. Missing cost (589)

Missing, stale or expired cost has **exactly one effect**: the margin estimate is not a current fact. It never
causes:

- an ERPNext Price List or ERPNext Item rate to be used as a selling price (463, 589, 655);
- a price to become unpriced, or a sale to be blocked, through cost alone (any block is an explicit RT-284 policy
  under G2, never a side effect of this feed);
- a live call to ERPNext to "fill the gap" (573);
- a zero or default cost being substituted.

## 8. Security, sensitivity and policy hooks

### 8.1 Sensitivity

Cost and margin are commercially sensitive. The draft gates every cost/margin read behind a capability in the
RT-284 catalogue (P-A), for example `pricing.cost:read`, at tenant or store scope (P-B). Until PE-BC3, it maps to
the existing role set: owner, tenant_admin and, if CR-9 allows, store_manager. The capability name, risk tier
and who holds it are owner/RT-284 choices (CR-9). Cost is never logged in full, never sent to POS, and holds no
PII (§XIV).

### 8.2 What RT-284 receives

RT-284 owns 583–588. This plan hands it, through the margin result (§6.2): `cost.amount`, `cost.basis`,
`cost.freshness`, `cost.asOf`, `marginPct`, and the `snapshotId` (so facts can freeze the cost they were judged
on, P-E). No guardrail logic is planned here.

### 8.3 Audit

Ingest emits a structured log per window, with counts by status. It never logs amounts. A failed or refused report
is observable, with a typed error (Connector Principle V). Superseding is append-only, so "which cost did
preview X use" is answerable from `snapshotId`.

## 9. Contract-first order (per repository)

Each step is a separate future Jira item. **None is created by this plan** (RT-282 practice: items are created
after ratification). `[GATED]` items need their own owner authorization.

| Step | Repo / path | Item (proposed) | Depends on | Delivers |
|---|---|---|---|---|
| C-1 | Backend-Core `packages/contracts/openapi/erpnext-connector/cost-reference.yaml` | `[GATED OpenAPI]` Cost Reference feed + report contract, with structural conformance spec | Ratified CR-1–CR-4, CR-8, CR-12 | §5.1 surface, §4.1 entry shape, closed error set |
| C-2 | ERPNext-Connector `specs/0xx-cost-reference-reader/` + `contracts/backend-core/PIN` | Connector spec: basis readers on v16 (resolves every §5.3 "verify" row), Compatibility Profile capabilities, PIN to C-1 | C-1 | Verified field mapping, failure taxonomy |
| C-3 | Backend-Core `packages/db/drizzle/` | `[GATED migration]` `cost_reference_snapshots` (+ observations), RLS, immutability trigger, key index | C-1 | §4.1 / §4.2 storage |
| C-4 | Backend-Core `apps/api` | Feed + report ingest runtime (request scheduler, idempotent ingest, dedupe, supersede, freshness) | C-1, C-3 | Snapshots land |
| C-5 | ERPNext-Connector runtime | Poller + reader + reporter (pattern of `bin_view/`) | C-2, C-4 deployed | Live feed |
| C-6 | Backend-Core `packages/contracts/openapi/` | `[GATED OpenAPI]` Margin fields in the PR-04 preview/inquiry contract + cost-reference console read | C-1; RT-282 PR-04 | §6.2 shapes, capability gating |
| C-7 | Backend-Core `apps/api` | Margin estimator (pure, property-tested) wired into Impact Preview / inquiry | C-6, C-4; RT-282 PR-08 (resolver), RT-484 runtime | §6 behaviour |
| C-8 | Admin-Console | Render margin, freshness, feed lag (consumer only) | C-6 | UI |
| C-9 | Verification | lab-03 end to end: ERPNext value → snapshot → preview margin; stale and missing paths; no live call on the sale path | C-5, C-7 | Runtime evidence |

**External dependencies:**

- RT-282 PR-04 (inquiry/authoring contract), PR-05 (schema) and PR-08 (resolver) come before C-6/C-7.
- RT-284 PE-BC1 is needed for a real capability code; before that, role mapping applies (§8.1).
- RT-281 Sell Units are needed for any UOM other than `each` (CR-11).
- RT-294 (Gate 3) is needed for margin on tax-inclusive Books, unless CR-6 chooses otherwise.

C-1 to C-5 (the feed) do **not** depend on the pricing runtime, so the feed can run and gather history before
margin is shown.

**Test strategy, written now so the contracts are testable:**

- C-4: idempotent replay, key conflict, out-of-order `as_of` does not supersede, dedupe on unchanged content,
  cross-tenant `requestRef` → 404, RLS matrix.
- C-5: Connector unit tests per basis, including `missing` reasons, negative/zero valuation and UOM conversion.
- C-7: property tests: margin uses only decimal arithmetic; a stale or expired cost never yields
  `status: estimated`; changing cost never changes a spec 041 resolution (589).

## 10. Owner decisions needed for ratification (open, **not decided here**)

| ID | Question | Options |
|---|---|---|
| **CR-1** | Which cost bases are in v1, and which one drives margin per tenant? For `standard`, which buying Price List? | (a) `valuation` only; (b) `valuation` + `last_purchase`; (c) all three, tenant chooses the margin basis |
| **CR-2** | Cost scope granularity | (a) per store (mapped warehouse valuation); (b) per ERPNext Company; (c) store, falling back to company when the store has no value |
| **CR-3** | Feed cadence, and whether a Change Set validation may trigger an out-of-cycle (still asynchronous) request | (a) scheduled only, interval X; (b) scheduled + on-demand at validation |
| **CR-4** | Freshness thresholds (`fresh_for`, `expire_after`) per basis, and who sets them | (a) system constants; (b) tenant-configurable within system bounds, as RT-284 policy entries |
| **CR-5** | How stale cost is displayed (582) | (a) withhold margin, show "cost stale since `asOf`"; (b) show a clearly labelled stale estimate with `asOf` |
| **CR-6** | Margin on **tax-inclusive** Books before RT-294 / Gate 3 | (a) `unavailable(tax_basis_unresolved)` until G3; (b) an explicitly labelled "gross margin vs tax-inclusive price"; (c) wait for RT-294 before C-7 |
| **CR-7** | Margin definition | (a) margin on net price; (b) markup on cost; (c) both, labelled |
| **CR-8** | Is a standing, history-keeping Cost Reference store acceptable under the 014 OQ-1 "no standing mirror" posture? How long is history retained? | (a) yes, current + superseded history, retention N; (b) current row only; (c) run-scoped only, as for Bin (would not meet 573 without live calls) |
| **CR-9** | Who may see cost and margin? Capability name and risk tier | (a) owner/tenant_admin only; (b) also store_manager for their stores; POS in no option |
| **CR-10** | Cost currency ≠ Book currency | (a) margin `unavailable`; (b) an approved FX reference converts at authoring time only (481–482), with its own provenance |
| **CR-11** | Cost UOM ≠ `each` before RT-281 | (a) `unavailable(uom_unconvertible)`; (b) use the ERPNext UOM conversion factor reported by the Connector |
| **CR-12** | Contract home | (a) new `erpnext-connector/cost-reference.yaml`; (b) extend `stock-view.yaml` (breaks its no-valuation invariant, F-2) |

When these are ratified, Confluence (the Pricing page or a decision record) should record them as durable
decisions, and the C-items in §9 can be created.

## 11. Risks and what was not verified

- **ERPNext semantics (§5.3) are NOT VERIFIED** on v16.51.0. In particular: whether `Item.last_purchase_rate` is
  per Company, how negative-stock valuation appears, and what `as_of` source to use. C-2 must settle these on
  lab-03 before C-5.
- **Valuation meaning varies by method** (FIFO vs Moving Average). Two tenants' "valuation" margins are not
  comparable. `valuationMethod` is kept in provenance, but the UI must not imply otherwise.
- **Multi-company tenants:** if one tenant spans several ERPNext Companies with different currencies, CR-2 and
  CR-10 interact. No such tenant is known; not verified.
- **Feed volume** (items × stores × bases per interval) is unmeasured. The 019 window limit (`maxWindows × maxItems`)
  may need its own value. No row count was taken.
- **Sensitivity before RT-284 lands:** until PE-BC1/BC3, gating is role-based (§8.1), as it is for other
  sensitive reads today.
- No tests or runtime were run. This is static reading of `main` plus Jira and Confluence.

## 12. Acceptance-criteria trace (RT-489)

| RT-489 scope / AC | Where |
|---|---|
| Snapshot fields: amount, currency, UOM; basis; source/provenance; `as_of` and freshness | §4.1, §4.3 |
| Feed ERPNext → Connector → Backend-Core; cadence, idempotency, tenant/store scoping | §5.1, §5.2, §5.4, §5.5 |
| Margin from declared basis; stale cost never shown as current margin | §6.1, §6.3 |
| Missing cost never makes ERPNext the price authority (589) | §3.2, §7 |
| Contract-first order, listing contract changes per repo | §9 |
| Out of scope respected (583–588 → RT-284; 587 → G2) | §1, §6.3, §8.2 |
| A plan exists covering the scope | this file |
| No code, OpenAPI or migration changes | the PR diff is this one file under `services/backend-core/docs/planning/` |
