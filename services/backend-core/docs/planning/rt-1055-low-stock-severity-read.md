# RT-1055 — Low-stock severity read for the Overview: decision record and contract draft

> **Status:** decision record + `[GATED]` contract draft (Work Mode: **Planning**, contract-first).
> **Jira holds the live status.** This file records the 2026-11-02 planning pass and is not a status tracker.
>
> **Authority.** The five decisions below were **selected under the owner delegation of 2026-11-02
> (captain session), recommended option; the owner may revisit.** The same delegation is the explicit
> `[GATED]` approval RT-1055 AC2 asks for, so the draft is merged as **contract-only**:
> `packages/contracts/openapi/inventory/low-stock.yaml` (`1.0.0-draft`), operation `consoleListLowStock`,
> `x-runtime-status: contract-only`.
>
> No runtime, migration, package, CI/policy or Admin-Console change.
>
> **Sources:** Jira RT-1055 (this item) and RT-993 (origin: the Overview «قريبًا» frame, comment 15088);
> `origin/main` **`a43ad962c`** (read-only inspection): `packages/contracts/openapi/inventory/inventory.yaml`
> (`1.8.0-draft`), `catalog/console-catalog.yaml`, `console-sales-by-store.openapi.yaml` (RT-1008, the
> console-read precedent reused here), `apps/admin-console/DESIGN.md` §12.4, and
> `apps/api/src/inventory/sale-effects/*` + `catalog/sales/sales.service.ts` (RT-427 sale effects).
> No runtime was exercised. Query cost and row volumes are **NOT VERIFIED**.

---

## 1. The need, and what main serves today

DESIGN.md §12.4 puts a «low stock» list in the Overview side column: *items sorted by severity, a level bar
per item, red only below the critical level*. RT-993 ships it as a «قريبًا» frame with no figures, because:

- **No threshold exists.** No contract or table on `main` holds a reorder, minimum or critical level
  (`grep -rn "reorder\|min_stock\|low_stock"` over `services/backend-core` finds nothing).
  The Store Override holds `price`, `isActive` and `taxCategory` only (`console-catalog.yaml` `StoreOverride`).
- **On-hand exists, per pair only.** `getOnHand` (`inventory.yaml`) returns one (store, product) derived
  on-hand, with `sellableQuantity` and `negativeBalance`. A pair with no movement reads a deterministic zero
  (FR-005). There is no scope-wide read and no ordering.
- **Sales move stock.** RT-427 is on `main`: sales, voids and returns write their Inventory Effects in their
  own transaction (`sales.service.ts`, `sale-effects-report.ts`). So the derived on-hand reflects every sale
  the server has received, and nothing still queued on a terminal.

The Console cannot compute severity without inventing a threshold, which UX-13.5 forbids.

## 2. Decisions

Each decision lists the options, the recommendation, and what was applied.

### LS-1 — Where the thresholds live and who sets them

| Option | Effect |
| --- | --- |
| A. Tenant Catalog only (one level per product) | Simple, but one store's shelf differs from another's; a tenant default cannot fit a small and a large store. |
| B. Store Override only (per store × product) | Exact, but every store must be set up before anything shows. |
| **C. Both: Tenant Catalog default, Store Override deviation (recommended)** | Matches catalog authority (root `CLAUDE.md` §5) and how price/availability/tax already resolve (Tenant ⊕ Store Override). |

Levels: **a required `reorderLevel` (> 0) and an optional `criticalLevel` (> 0, ≤ `reorderLevel`)**, in the
product's stocking unit. One level only would not express "red only below the critical level".

Resolution is **per pair, not per field**: when the store's active override sets a reorder level, *both*
levels come from the override (`thresholdSource: store`); otherwise both come from the tenant product
(`thresholdSource: tenant`). Field-by-field mixing could produce a critical level above the reorder level.

Who sets them (recorded for the follow-up, not contracted here): tenant levels — `owner` / `tenant_admin`
(the CAT-W1 product write roles); store levels — `owner` / `tenant_admin` and `store_manager` for a store in
its scope (the CAT-W2 override roles; a level is operational, like availability). ERPNext's Item reorder
settings are **never** read or synced: thresholds are Retail Tower operational data.

**Applied:** C. **Follow-up (required before the runtime):** the threshold fields need persistence (columns
on the tenant product and the store override, or a dedicated table) and write operations on
`console-catalog.yaml`. That is a schema + contract change with its own `[GATED]` migration decision; it is
**not** made here. See §4.

### LS-2 — What severity means and how it sorts

| Option | Effect |
| --- | --- |
| A. Distance below the level (`reorderLevel − onHand`) | In units: 5 boxes and 5 kg do not compare; large-volume products always rank first. |
| **B. Ratio `onHand / reorderLevel` (recommended)** | Unit-free, 0 = empty shelf, directly the level bar's fill. |
| C. Days of cover (on-hand / sales velocity) | Better signal, but needs a sales-velocity metric contract that does not exist. |

Low = `sellableOnHand < reorderLevel`; `critical` = also `sellableOnHand < criticalLevel` (both strictly
below, matching "under a reorder level" and "red only below the critical level"). Without a critical level
the band is `low` and the item is never red.

Order: `critical` before `low`, then the exact ratio ascending, then `storeId`, then `productId`. The wire
`levelRatio` is truncated toward zero to four digits so a low item never reads `"1.0000"`.

**Applied:** B. C is a later option once a velocity metric is contracted.

### LS-3 — On-hand source, freshness, unknown on-hand

| Option | Effect |
| --- | --- |
| A. Physical on-hand (`OnHand.quantity`) | Counts damaged, held and recalled stock that cannot be sold. |
| **B. Sellable on-hand (`OnHand.sellableQuantity`) (recommended)** | What the shelf can actually sell. |
| C. ERPNext Bin / stock-view (`erpnext-connector/stock-view.yaml`) | ERP is not the operational authority and lags posting. Rejected. |

Freshness: one consistent snapshot, `asOf` = its server time, `completeness: received_only` (the
RT-1008 / RT-649 wording): sales still queued on a terminal are not in it.

Unknown (UX-13.23, never shown as zero): a pair with **no recorded movement** is `unknown` — the ledger's
FR-005 zero is not an observed zero. It is never listed and is counted in `unknownOnHandCount`.
A **negative** sellable on-hand is a stock discrepancy, out of RT-1055 scope: never listed or ranked, counted
in `negativeOnHandCount`. `evaluatedCount = 0` lets the widget say "no threshold configured" instead of
"nothing is low".

**Applied:** B, with `known` / `unknown` / `negative` states.

### LS-4 — Scope, roles, errors and paging

| Option | Effect |
| --- | --- |
| A. One store per call (`store_id` required) | The Overview of a multi-store owner would need N calls. |
| **B. Every store in scope, optional `store_id` narrowing (recommended)** | One call for the Overview; the store filter for a store view. |

- Path `GET /api/v1/inventory/low-stock`, a console read (the `/api/v1/...` console family), not the
  `/api/inventory/v1/...` operator module, whose 403 semantics differ. New self-contained file
  `inventory/low-stock.yaml` rather than an additive change to `inventory.yaml` (see §3).
- Auth: `cookieAuth` only; `SessionOnlyAdminGuard` → `TenantContextGuard` → `RolesGuard`; roles `owner`,
  `tenant_admin`, `store_manager`; operator-surface store scope as `console-catalog.yaml`.
- Non-disclosing 404 for a role outside the list and for a `store_id` outside the scope, soft-deleted or of
  another tenant. No 403.
- Bounded top-N: `limit` 1..50, default 10, **no cursor**. `belowReorderCount`, `criticalCount` and
  `truncated` tell the widget how many more there are. A full paged "all low stock" screen is not needed by
  §12.4 and would be an additive later change.
- Evaluated pairs: product `active`, available at the store (resolved `isActive`), store not soft-deleted
  (an inactive store is evaluated and flagged `storeStatus: inactive`), resolved reorder level.
- Rate-limit class `expensiveRead` (scope-wide compute-on-read sum). Not audited (inventory read with no money
  figure, as `getOnHand` / `listInventorySafetyFindings`). `Cache-Control: no-store`.

**Applied:** B.

### LS-5 — Does tracked stock (RT-449 family) change any of this?

| Option | Effect |
| --- | --- |
| **A. No change in v1 (recommended)** | Levels per (store, product); on-hand sums every identity's `sellable` position. |
| B. Per-lot levels / expiring-lot weighting | Needs the near-expiry window (RT-50 B1, still off); duplicates the safety findings. |

Held stock (`quality_hold`, `recall_hold`) is already outside `sellable`. An expired lot still in `sellable`
counts until the governed `sellable → expired` move; `listInventorySafetyFindings` already reports it.

**Applied:** A.

## 3. Contract placement

**New file** `packages/contracts/openapi/inventory/low-stock.yaml`, not additive to `inventory.yaml`:

- `inventory.yaml` is the operator module (`/api/inventory/v1`, 403 for a role refusal, cookie or bearer);
  this read follows the console surface (session-only guard, non-disclosing 404), as
  `console-sales-by-store.openapi.yaml` did for RT-1008.
- A self-contained file adds nothing to a 2 141-line contract that other in-flight issues bump, and no
  consumer pins it yet, so `contracts/check` pins are unaffected.
- Its rate-limit class lives in `apps/api/test/console-rate-limit/classes/inventory/low-stock.rate-limit.yaml`
  (RT-805).

## 4. Follow-ups (identified, not created — RT-1055 AC3)

1. **Planning / `[GATED]` contract + migration — threshold persistence and writes (prerequisite).** Add
   `reorderLevel` / `criticalLevel` to the Tenant Catalog product and the Store Override (or a dedicated
   table), with their write operations in `catalog/console-catalog.yaml` and their validation
   (`0 < critical ≤ reorder`, product stocking unit). Needs a migration decision; this record does not make it.
2. **Implementation — runtime of `consoleListLowStock` (Backend-Core).** Controller, guards, store scope,
   one-snapshot query over the evaluated pairs, ordering and counts; remove the operation's
   `x-runtime-status` / `x-runtime-note` markers; contract tests; route conformance. Blocked by 1.
3. **Admin-Console (later, separate product):** replace the RT-993 «قريبًا» frame once 2 is on `main`.

## 5. Out of scope

The runtime, any migration, the Admin-Console widget, stock discrepancies (negative on-hand), sales velocity
/ days of cover, and per-lot thresholds.
