# ADR-0002 — Procurement Boundary: Progressive Mediate (target) · Delegate (current runtime)

**Status:** **Owner-ratified target: Progressive Mediate (2026-11-19). Current runtime: Delegate restrictions stay in force.** This ADR supersedes the 2026-06-08 Delegate decision *as the selected future product/architecture target only*. It authorizes no implementation.
**Dates:** 2026-06-08 (Delegate ratified) · 2026-11-19 (owner decision: target Progressive Mediate)
**Deciders:** Owner (Ahmed Shaaban).
**Decision record:** [ADR-RT-002](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/84606983) (Confluence, 2026-11-19), aligned with [CR02](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/84050068) and [W2 RT-1479 OD-4](https://rahmaqanater.atlassian.net/browse/RT-1479?focusedCommentId=17751). Reconciled in the repository by RT-1499 (Docs).
**Relates to:** [ADR-0001 — Catalog Authority](https://github.com/Kemetra/Orchestrator/blob/420db8b1176e2fbf67eb4d32f520d09e2b912ecf/docs/architecture/adr-0001-catalog-authority.md) (unchanged; frozen Orchestrator copy).

> **Target, not a build authorization.** Nothing here grants code, API, permission, contract, Purchase Order write or runtime migration authority, and nothing here records any of that as done. Each later slice needs its own Jira issue, Work Mode, owner authorization, acceptance criteria and runtime proof. If this target conflicts with code, GitHub `main` is runtime truth: mark it *Needs verification* and do not improvise contracts.

> **Provenance.** The earlier copy of this ADR lived in `Kemetra/Orchestrator` (`docs/architecture/adr-0002-procurement-boundary.md`, `main` at `420db8b1176e2fbf67eb4d32f520d09e2b912ecf`, still "Accepted Option B Delegate"). That repository is a frozen historical source (AD-ORCH-003), so the reconciled ADR lives here. The Orchestrator copy is not edited and is superseded by this file.

---

## 2026-11-19 owner decision: target Progressive Mediate

**Decision.** The target procurement architecture is **Progressive Mediate**: phased, neither the original all-DocTypes Option A nor Option C's unconditional Retail Tower PO writer. Option B (Delegate) and Option C (Hybrid) are no longer the selected future target. Their June rationale and the option comparison below stay as evidence.

**Target invariants**

- **Retail Tower (Backend-Core)** owns retail product authority, supplier–Retail Item sourcing context, replenishment recommendation, and governed Purchase Intent with merchant approval. Intent is not a financial Purchase Order, and there is no autonomous purchase submission.
- **ERPNext** remains the sole authority for formal Purchase Order, Receipt, Invoice and Return, supplier accounting, AP, purchase tax, valuation and landed cost. Backend-Core never builds a second financial or stock ledger.
- **Integration path:** Admin-Console/POS → Backend-Core → ERPNext-Connector → ERPNext. The Connector is the only ERPNext adapter. No direct ERP call and no ERPNext UX exposed to Retail Tower customers.
- **Receipt is not sellability.** No unverified receipt promotes stock to sellable; W3 reconciles physical inventory.
- **W4 tax scope and Pilot GO are not activated** by this decision.

**Phased adoption (design now, execution later)**

| Phase | Scope | Gate |
|---|---|---|
| 0 — Delegate continuity | Existing procurement-read and ERPNext-native buying paths unchanged | No regression |
| 1 — Supplier/catalog sourcing | Supplier–item relationship, validated ERP Supplier reference, purchase UOM, MOQ, lead time | Approved model and mapping, RLS, catalog identity |
| 2 — Replenishment and merchant decisions | Explainable shortages, explicit Purchase Intent, approvals | Policy, roles, price/qty/currency rules, reapproval |
| 3 — Approved ERP order mediation | Authorized intent becomes a typed Connector operation; ERPNext owns the PO | Contract-first OpenAPI, mapping, idempotency, authorization, provenance, error recovery, ERPNext v16 bench, rollback, runtime E2E |
| 4 — Receiving and AP visibility | ERPNext PO/receipt/invoice status shown in Retail Tower UX | Verified ERPNext v16 interfaces; receipt, stock and finance parity; no direct financial writes |

**Current vs target.** Until an independent contract-first typed buying boundary and its authorizations are approved, tested and deployed, the **Delegate restrictions below remain the current runtime**: buyers use ERPNext's native Buying module and Retail Tower writes no Buying DocType.

---

# Historical decision record (2026-06-08, Delegate) — preserved as provenance

> Everything below is the original ADR-0002 text, unchanged except for two link targets (now pointing at the frozen Orchestrator copy). Where it says "Accepted" or "Recommendation", it describes the **2026-06-08** state, not the current target above.

**Status:** **Accepted — Option B (Delegate), with Option C (Hybrid) as the named upgrade path.** Ratified 2026-06-08.
**Date:** 2026-06-08 (proposed) · 2026-06-08 (ratified)
**Deciders:** Owner (Ahmed Shaaban) — ratified the planning pass's recommended option. Decision: **Delegate procurement to ERPNext** as the starting position; **escalate to Hybrid (C)** only if a concrete purchase-origination need (e.g. data-driven replenishment) emerges.

> **RATIFICATION NOTE (2026-06-08):** The owner accepted **Option B (Delegate)**. Buyers operate
> ERPNext's native Buying module; Retail Tower writes **no** Buying DocType and reads procurement's
> result (stock + cost) via the already-live `Bin` / `Stock Reconciliation` read-path. The heavy Arc B
> build (G1 extension, DP2 procurement contract, Connector procurement adapter) is **NOT undertaken** —
> [`../roadmap/arc-b-procurement-plan.md`](https://github.com/Kemetra/Orchestrator/blob/420db8b1176e2fbf67eb4d32f520d09e2b912ecf/docs/archive/roadmaps/arc-b-procurement-plan.md) stages 1–3 are **shelved**
> unless/until the ADR is re-opened to Option C. The "Buying module 0% covered" gap is reclassified from
> *unmet in-scope gap* to **delegated to ERPNext by decision**. Acceptance confers planning closure on
> Arc B; it does **not** authorize any implementation — any future Option-C escalation requires re-opening
> this ADR and a separate scoped approval.
**Relates to:** [ADR-0001 — Catalog Authority](https://github.com/Kemetra/Orchestrator/blob/420db8b1176e2fbf67eb4d32f520d09e2b912ecf/docs/architecture/adr-0001-catalog-authority.md) (this ADR extends ADR-0001's boundary reasoning to the inbound/procurement flow; it does not modify ADR-0001).

> **Accepted decision, not a build authorization.** Option B delegates procurement to ERPNext.
> The shelved Arc B stages remain historical planning evidence; any Option-C work requires this
> decision to be reopened and separately approved.

---

## Context

Every Retail Tower capability covered today is **sell-side**. The 2026-06-08 second-pass capability scan
(`docs/roadmap/erpnext-capability-gap.md`; an HTML preview was generated locally at the time and is not kept)
records:

- **Buying module: 9 DocTypes, 0 covered** — the single largest coherent gap. `Supplier`, `Purchase Order`,
  and `Supplier Quotation` are 🔴 `none` (in-scope, no spec touches them); `Request for Quotation` and
  `Supplier Scorecard` (+ children) are ⚪ `out-of-scope`.
- The goods-in **Stock** DocTypes that procurement drives — `Purchase Receipt`, `Material Request` — are
  also 🔴 `none`; and `Purchase Invoice` (Accounts) is 🔴 `none`.
- The **read** side of stock is, by contrast, **already live**: `Bin` and `Stock Reconciliation` moved
  🟡 → ✅ after DP-019 T040/T041 and Connector PR #25 (`ce44129`) shipped and the reconciliation loop was
  live-validated (DP-019 `wave-status` / T042 PASS; this is DP2's staging self-report, not an
  orchestrator-run production check).

Procurement introduces an entirely **inbound** flow — `Supplier → Purchase Order → Purchase Receipt →
Purchase Invoice` — that **ERPNext owns natively**. Unlike returns (Arc A), which reuse the already-built
sell-side spine, procurement is a genuinely new arc with no existing machinery to extend. Whether Retail
Tower should own procurement at all, or delegate it to ERPNext and merely read the resulting stock/cost,
is an **ADR-0001-level boundary decision** — not a foregone build. This ADR exists to make that decision
explicit before effort is committed.

**Evidence HEADs (read-only, verified this pass):** Data-Pulse-2 `origin/main @ 865f157`;
Retail-Tower-ERP-Next-Connector `origin/main @ ce44129`; POS-Pulse `origin/main @ 302e201`
(POS is not on procurement's critical path — procurement is back-office, not POS).

## Decision Question

**Does Retail Tower _mediate_ procurement, or _delegate_ it to ERPNext?**

- **Mediate (Option A):** Retail Tower owns the procurement flow the way it owns the sell-side — a DP2
  procurement **contract** (G2) plus a **Connector procurement adapter** that writes `Supplier` /
  `Purchase Order` / `Purchase Receipt` (/ `Purchase Invoice`) into ERPNext, mirroring the sell-side
  posting architecture.
- **Delegate (Option B):** Procurement is performed **directly in ERPNext** (buyers use ERPNext's native
  Buying UI). Retail Tower only **reads** the resulting stock and cost back — reusing the already-live
  `Bin` / `Stock Reconciliation` read-path. Retail Tower writes nothing on the buy-side.

In **both** options, **ADR-0001 catalog authority is unchanged**: the Data-Pulse Tenant Catalog (DP-003)
remains the authoritative retail/operational product record, and ERPNext `Item` remains the accounting
identity only. **Procurement does not make ERPNext the catalog source** — a Purchase Order references the
same `tenant_product ↔ ERPNext Item` mapping (DP-013) that the sell-side already uses.

---

## Options Considered

### Option A — Mediate (DP2 contract + Connector procurement adapter)

Retail Tower originates procurement intent. A DP2 procurement contract defines the work-item shapes
(supplier-upsert, purchase-order, goods-receipt, supplier-invoice); the Connector adapter applies them to
ERPNext via the same boundary discipline as Connector-006 (sales posting): idempotent, DLQ-on-failure,
ERPNext `name` as external id.

- **Control:** Highest. Procurement state is observable and governable from the Retail Tower control
  plane (Console can surface PO status, receipts, AP).
- **Complexity:** Highest. Requires a **G1 mapping extension** to Supplier/Purchase DocTypes, a **new DP2
  contract** (G2), a **new Connector adapter**, and new surfaces. This is net-new write machinery on a
  side of the system that has none today.
- **ADR-0001 consistency:** Strong — mirrors the established sell-side pattern (DP2 contract → Connector
  adapter → ERPNext), keeping the Connector as the *only* component that speaks Frappe/ERPNext.
- **Effort:** Heaviest of all arcs. Full G1-ext + contract + adapter + surfaces stack.

### Option B — Delegate (procurement in ERPNext; Retail Tower reads stock/cost)

Buyers operate ERPNext's native Buying module. Retail Tower does not write any Buying DocType. The effect
of procurement — increased stock, updated valuation/cost — flows back through the **already-live**
`Bin` / `Stock Reconciliation` read-path (DP-019 / DP-017).

- **Control:** Lower. Procurement governance lives in ERPNext, outside the Retail Tower control plane;
  Console cannot drive PO/receipt workflow.
- **Complexity:** **Lowest, and partly pre-built.** The stock read-back is **already live** (Bin +
  Stock Reconciliation ✅ as of 2026-06-08, Connector PR #25 / DP PR #528). No G1 extension, no new DP2
  procurement contract, and no Connector write-adapter are required for the core "read the result" path.
- **ADR-0001 consistency:** Strong — consistent with ADR-0001's principle that ERPNext owns accounting/
  posting concerns and Retail Tower reconciles by correlation. Procurement is treated like any other
  ERPNext-native back-office function Retail Tower observes but does not author.
- **Effort:** Lightest. The expensive part is already shipped; remaining work is surfacing cost/landed
  values in read models (small) if even that is wanted.

### Option C — Hybrid (mediate the master + intent; delegate the financial document)

Retail Tower mediates the **Supplier master** and the **Purchase Order** (so reorder/replenishment intent
can originate from Retail Tower data, e.g. demand signals), while the **Purchase Receipt** and especially
the **Purchase Invoice** (AP / tax) are **delegated to ERPNext**. The stock effect still returns via the
live Bin/reconciliation read-path.

- **Control:** Medium — Retail Tower controls vendor master + buying intent; ERPNext owns the financial
  document and AP.
- **Complexity:** Medium — a partial G1 extension (Supplier, Purchase Order only) and a smaller DP2
  contract; no AP/invoice write path, which is where G6 (Egypt VAT) would otherwise bite.
- **ADR-0001 consistency:** Strong — keeps the financial/tax document (Purchase Invoice) in ERPNext, the
  natural home of the GL, while letting Retail Tower own the operational buying decision.
- **Effort:** Medium — between A and B; defers the heaviest (AP + tax) piece.

---

## Recommendation *(2026-06-08 state; superseded as target, see top. RATIFIED 2026-06-08 — Option B accepted; Option C is the named upgrade path)*

**Accepted: Option B (Delegate) as the starting position, with Option C (Hybrid) as the explicit
upgrade path if a concrete procurement-origination need emerges.**

Reasoning (the basis the owner ratified):

1. **Option B's core is already built and live-validated.** The stock read-back (Bin, Stock Reconciliation)
   that Delegate depends on shipped this pass. Choosing B captures procurement's *observable result* at
   near-zero marginal cost, with no new write-boundary risk.
2. **No covered capability today is buy-side.** Opening a full Mediate (Option A) write path is the
   heaviest arc in the program and competes for the same boundary-hardening attention as the sell-side
   residuals that are not yet deployed (DP-015 G9; Connector-006 reversal residual). Sequencing a new
   heavy write arc ahead of finishing the built-but-undeployed sell-side spine is hard to justify.
3. **Hybrid (C) is the natural escalation.** If/when Retail Tower needs to *originate* purchase orders
   (e.g. data-driven replenishment), C adds exactly the Supplier + Purchase Order mediation needed and no
   more — deferring the AP/tax (G6) weight that makes full Option A expensive.

**Whether procurement is in Retail Tower's scope at all is an open owner-intent question this ADR cannot
resolve from read-only evidence.** If the owner's intent is that procurement is simply out of Retail
Tower's mandate, Option B with *no* additional read-surfacing is the terminal answer.

---

## Consequences

If this ADR is **Accepted as Option B (Delegate):**
- Arc B's heavy build (G1 extension, DP2 procurement contract, Connector procurement adapter) is **not
  undertaken**. The conditional plan's stages 1–3 are shelved; only optional cost/landed-value
  read-surfacing (if wanted) remains.
- The roadmap's "Buying module 0% covered" gap is reclassified from *unmet in-scope gap* to *delegated to
  ERPNext by decision* — analogous to the ⚪ out-of-scope finance DocTypes.

If this ADR is **Accepted as Option A (Mediate) or Option C (Hybrid):**
- [`../roadmap/arc-b-procurement-plan.md`](https://github.com/Kemetra/Orchestrator/blob/420db8b1176e2fbf67eb4d32f520d09e2b912ecf/docs/archive/roadmaps/arc-b-procurement-plan.md) becomes the live sequencing
  plan and its dependency chain (G1-ext → DP2 contract → Connector adapter → surfaces) is in force.

### Per-gate consequences (per option)

| Gate | Option A — Mediate | Option B — Delegate | Option C — Hybrid |
|---|---|---|---|
| **G1** (mapping) | **Hard prerequisite, full extension.** Current G1 covers Item / Item Price / Barcode / Warehouse / SLE / Sales Invoice / Payment Entry / Tax — it does **NOT** cover Supplier or any Purchase DocType. A G1 extension to `Supplier`, `Purchase Order`, `Purchase Receipt`, `Material Request`, `Purchase Invoice` is required first. | **Not required for the core read path.** No Buying DocType is written, so no G1 mapping extension is needed; the existing Bin/Item/Warehouse mapping already backs the read-back. | **Partial extension:** `Supplier`, `Purchase Order` only. No mapping for Purchase Receipt / Purchase Invoice (delegated). |
| **G2** (contract) | **New DP2 procurement contract required.** Does not exist; must be authored and reviewed both sides before the adapter is built. | **None.** No new cross-boundary write contract; the read-back uses the existing DP-019 stock-view contract already merged. | **Smaller DP2 contract** — supplier-upsert + purchase-order operations only; no receipt/invoice write ops. |
| **G6** (tax/fiscal) | **Engaged.** `Purchase Invoice` carries input VAT; the AP write path pulls in Egypt VAT modeling (G6), the same gate flagged for DP-016 / POS-012. | **Not engaged.** The Purchase Invoice (and its tax) lives entirely in ERPNext; Retail Tower never writes it. | **Deferred / not engaged.** By delegating the Purchase Invoice, C keeps G6 out of the buy-side write path; engages only if AP mediation is later added. |
| **G5** (idempotency) | Required on all procurement write ops (receipt / supplier-invoice posting must be replay-safe), as for Connector-006. | Not applicable to a read-only path beyond the already-validated reconciliation idempotency. | Required on the mediated ops (supplier-upsert, PO) only. |

> **Docs-only record.** This ADR coordinates a decision; it does not implement. Status was **Accepted** (2026-06-08 state; see the 2026-11-19 decision at the top)
> (Option B — Delegate; ratified 2026-06-08, per the header) — acceptance confers *planning* closure only,
> not implementation authorization. No spec, contract, migration, or code is produced or dispatched from
> this record.
