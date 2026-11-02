# RT-1064 — Low-stock thresholds: storage, writes and migration shape (decision record + contract draft)

> **Status:** decision record + `[GATED]` contract draft (Work Mode: **Planning**, contract-first).
> **Jira holds the live status.** This file records the 2026-11-02 planning pass and is not a status tracker.
>
> **Authority.** The five decisions below were **selected under the owner delegation of 2026-11-02
> (captain session), recommended option; the owner may revisit.** The same delegation is the `[GATED]`
> approval for the contract, which is merged as **contract-only**:
> `packages/contracts/openapi/catalog/stock-levels.yaml` (`1.0.0-draft`), five operations, each
> `x-runtime-status: contract-only`.
>
> No runtime, migration, package, CI/policy or Admin-Console change. The migration is **described** in TH-5;
> it is not written or run here.
>
> **Origin:** RT-1055 decision record §4, follow-up 1 (`docs/planning/rt-1055-low-stock-severity-read.md`,
> PR #236, `a92b23c7`). **Sources** (read-only, `origin/main` **`e85325004`**):
> `packages/contracts/openapi/inventory/low-stock.yaml`, `catalog/console-catalog.yaml` (`1.1.0-draft`),
> `catalog/tracking-profile.yaml`, `packages/db/src/schema/catalog/tenant-products.ts`,
> `store-product-overrides.ts`, `packages/db/src/schema/inventory/stock-movements.ts`, pricing specs
> `specs/041-pricing-domain/` (decision record OD-5, data-model §3) and
> `specs/044-pricing-legacy-cutover/plan.md` (§6.2 freeze, §9 OD-5 split, MC-5). No runtime was exercised.

---

## 1. What RT-1055 already fixed, and what is left

RT-1055 LS-1 fixed the **semantics**: a required `reorderLevel` (> 0) and an optional `criticalLevel`
(> 0, ≤ `reorderLevel`), in the product's stocking unit, layered as a tenant default with a per-store
deviation, resolved **per pair** (`thresholdSource: tenant | store`), never from ERPNext. The merged read
`consoleListLowStock` depends on that.

Left open, and decided here: where the values are stored (TH-1), the exact validation (TH-2), the precedence
edge cases (TH-3), who writes them and how (TH-4), and the migration shape (TH-5).

## 2. Decisions

### TH-1 — Storage

| Option | Effect |
| --- | --- |
| A. Columns on `tenant_products` (default) and `store_product_overrides` (deviation) | Matches the RT-1055 wording literally. But it adds a **fourth concern** to the override row that pricing **OD-5** is splitting by concern (`price` → Pricing, `is_active` → Assortment RT-281, `tax_category` → Fiscal RT-294). It couples thresholds to that row's lifecycle: the `store_product_overrides_at_least_one_override` CHECK, `consoleRetireStoreOverride` (retiring availability would drop the store's levels; `price_override_present` would block retiring a level), the 044 MC-5 per-tenant **freeze trigger** on both tables after the price cutover, and PR-16c's "removable once all three domains have cut over" precondition, which would gain a fourth domain. Every threshold change would also emit a `catalog_change_log` row and wake the POS read-down for data the POS never uses. |
| B. Columns on `tenant_products` (default) + a dedicated store table | Avoids the override row, but still puts a non-catalog concern on `tenant_products` (also under the MC-5 freeze trigger) and splits one rule over two storage shapes. |
| **C. One dedicated table `product_stock_levels`, one row per (tenant, product, store-or-tenant scope) (recommended)** | One concern, one owner, one resolver, one audit shape. Keeps the RT-1055 layering exactly (a tenant row is the default, a store row the deviation) without touching any row Pricing, Assortment or Fiscal will split, freeze or retire. No POS read-down change. |
| D. Two dedicated tables (tenant, store) | Same isolation as C, but two write paths and two RLS/grant sets for one rule. |

**Applied: C.**

**How C fits OD-5.** OD-5 moves each concern of the legacy override row to its own owner and leaves the row as
a read-only compatibility projection to be removed when all three owners have cut over (044 §9). C adds no
column to that row and no column to `tenant_products`, so the split, the MC-5 freeze trigger and the PR-16c
removal precondition are unchanged. It also follows OD-5's own direction: a concern with its own owner gets its
own storage. Catalog authority (root `CLAUDE.md` §5) is respected: thresholds are Retail Tower operational
data owned by Backend-Core (inventory replenishment parameters), layered like the catalog, and **never**
derived from, synced with or written to the ERPNext Item (its reorder settings are not an input).

**Owner and surface.** The table belongs to Backend-Core's inventory domain (schema under
`packages/db/src/schema/inventory/`), because its only consumer is the low-stock read. It is written through
the console **catalog** path family (`/api/v1/catalog/products/{productId}/stock-levels…`) because the
Admin-Console manages it per product, next to the product's other store settings.

### TH-2 — Validation

| Option | Effect |
| --- | --- |
| **A. Two exact decimals, `0 < criticalLevel ≤ reorderLevel`, no unit on the wire (recommended)** | The level is a quantity in the stocking unit the (store, product) pair's movements are recorded in. That unit is single per pair and immutable once stock moves (FR-022, the `stock_movements_one_unit_per_product` exclusion guard, migration 0016). |
| B. Store a `stockingUnit` with each level and evaluate only on a match | Catches a tenant default used across stores that stock the product in different units, but the Catalog has no unit today (the unit lives on the movements), so the write could not validate it, and the merged read has no "unit mismatch" count. |
| C. Integers only | Fails weighed goods (kg). |

**Applied: A.** Rules:

- `reorderLevel`: required, strictly positive, exact decimal string, up to 15 integer and 4 fractional
  digits (`numeric(19,4)`), the `LevelQuantity` pattern already in `low-stock.yaml`. Never a float; stored
  as sent; never rounded.
- `criticalLevel`: absent or `null` (no critical level), or the same type, strictly positive.
- Cross-field: `criticalLevel ≤ reorderLevel`; **equal is allowed** (every low pair is then critical). The
  schema cannot express it, so the server answers **422 `critical_above_reorder`**; the database backs it with
  a CHECK (TH-5).
- Risk accepted: a store that stocks the product in another unit than other stores must get its own store
  level. Multi-unit products arrive with RT-281 Sell Unit modelling (pricing OD-2); TH-2 is revisited then.

### TH-3 — Precedence

| Option | Effect |
| --- | --- |
| **A. Per pair: an active store level supplies both values; otherwise the active tenant level supplies both (recommended)** | RT-1055 LS-1 as written. A store can say "no critical level here" (`criticalLevel: null`) even when the tenant has one. The resolved pair always satisfies `critical ≤ reorder`. |
| B. Per field (store value else tenant value) | A store `reorderLevel` below the tenant `criticalLevel` would resolve to `critical > reorder`. Rejected by LS-1. |
| C. Store only, no tenant default | Every store must be set up before anything shows. |

**Applied: A.** Edge cases:

- No active level at either layer: the pair has no threshold and is not evaluated (`evaluatedCount`
  excludes it).
- Retiring a store level falls back to the tenant level; retiring the tenant level leaves store levels
  untouched.
- A retired product or a soft-deleted store keeps its rows but is never evaluated (as in RT-1055).
- A store level of a store outside the caller's scope is still effective for that store; scope only limits
  what a caller sees and writes.

### TH-4 — Roles, audit and concurrency

| Option | Effect |
| --- | --- |
| **A. Catalog-write precedent: CAT-W1 roles for the tenant level, CAT-W2 roles for store levels; audited per mutation; `expectedUpdatedAt` precondition; no `Idempotency-Key` (recommended)** | Same guards, store scope, 404 rules and error vocabulary as `console-catalog.yaml` writes. |
| B. Owner / tenant_admin only for both | A store manager cannot tune its own shelf, which is the reason store levels exist. |
| C. `Idempotency-Key` on every write | Unnecessary: every write carries a precondition, so a retry never writes twice (a repeated set reads 409 `stale_write`; a repeated retire reads the non-disclosing 404, as no level is active any more). |

**Applied: A.**

- **Read** `consoleGetProductStockLevels`: `owner`, `tenant_admin`, `store_manager`. The tenant level is tenant
  data (all allowed roles); store levels only for stores in the caller's scope. Not audited (catalog reads,
  decision O-6). Rate-limit class `cheapRead`.
- **Tenant level** `consoleSetTenantStockLevel` (`PUT …/stock-levels`), `consoleRetireTenantStockLevel`
  (`POST …/stock-levels/retire`): `owner`, `tenant_admin`. `store_manager` and `store_staff` → 404.
- **Store level** `consoleSetStoreStockLevel` (`PUT …/stock-levels/stores/{storeId}`),
  `consoleRetireStoreStockLevel` (`POST …/stock-levels/stores/{storeId}/retire`): `owner`, `tenant_admin`,
  `store_manager`, store in the caller's scope.
- **Errors:** 400 `validation_error`; 401; 403 `origin_rejected` only (RT-430); 404 non-disclosing (role, foreign
  or absent product, store outside scope / foreign / soft-deleted, no active level on a retire); 409
  `stale_write`, and `product_retired` on a set (a retire is allowed on a retired product); 422
  `critical_above_reorder`; 429; 500. Writes are rate-limit class `write`.
- **Concurrency:** `expectedUpdatedAt` = the active level's `updatedAt`, or `null` on a set when the caller saw
  none; compared at millisecond precision; mismatch → 409 `stale_write`. Each accepted write gives a strictly
  later `updatedAt`. A retried set that already succeeded is therefore `stale_write`; a retried retire is the 404.
- **Audit:** one `audit_events` row per accepted write, in the same transaction:
  `catalog.stock_level.set`, `catalog.stock_level.retire`, `catalog.store_stock_level.set`,
  `catalog.store_stock_level.retire`; actor, tenant, product, store (store level), old and new values. A
  refused write writes no row.
- **Not** in `catalog_change_log` and not on the POS read-down: the POS never uses a threshold.

### TH-5 — Migration shape (described only; not written or run)

| Option | Effect |
| --- | --- |
| **A. One additive migration creating `product_stock_levels`, no backfill (recommended)** | Nothing to import: no threshold exists on `main` (RT-1055 §1), and ERPNext's Item reorder settings are deliberately not imported. Reversible while the table is empty. |
| B. Seed tenant levels from ERPNext Item reorder levels | Makes ERPNext a threshold source. Rejected (§5, RT-1055 LS-1). |

**Applied: A.** Shape for the Implementation issue (number assigned there, after `0076`):

- Table `product_stock_levels`: `id uuid PK`; `tenant_id uuid NOT NULL → tenants`; `product_id uuid NOT NULL`,
  same-tenant FK `(product_id, tenant_id) → tenant_products (id, tenant_id)` (target
  `uq_tenant_products_id_tenant` exists); `store_id uuid NULL → stores` (NULL = tenant level), same-tenant
  enforced as for `store_product_overrides`; `reorder_level numeric(19,4) NOT NULL`;
  `critical_level numeric(19,4) NULL`; `retired_at`, `created_at`, `updated_at timestamptz`;
  `created_by`, `updated_by uuid NOT NULL`; `correlation_id uuid NULL`.
- CHECKs: `reorder_level > 0`; `critical_level IS NULL OR (critical_level > 0 AND critical_level <= reorder_level)`.
- Partial unique indexes: `(tenant_id, product_id) WHERE store_id IS NULL AND retired_at IS NULL` and
  `(tenant_id, store_id, product_id) WHERE store_id IS NOT NULL AND retired_at IS NULL` (at most one active
  level per scope). A read index `(tenant_id, store_id) WHERE retired_at IS NULL` for the low-stock query.
- RLS: `ENABLE` + `FORCE`, tenant policy on `app.tenant_id` like the catalog tables; store scope enforced in
  the service with an explicit store predicate (the console-catalog rule). Runtime grants `SELECT`, `INSERT`,
  `UPDATE` only (retire is an update; no `DELETE`), registered through the RT-812 per-migration grant and
  probe files, never a baseline.
- No trigger into `catalog_change_log`; no freeze trigger (not a Pricing table).
- Down migration: drops the table, and **refuses when it holds rows** (the 044 R3 pattern), so a rollback
  never silently loses configured levels.

## 3. Contract placement

**New file** `packages/contracts/openapi/catalog/stock-levels.yaml` (`1.0.0-draft`), not additive to
`catalog/console-catalog.yaml`, which the issue allows when justified:

- `console-catalog.yaml` is fully served and its contract specs pin that posture: its exact GET set, its exact
  write set and "none is marked contract-only". Five contract-only operations there would break those pins
  and mix a contract-only slice into a shipped file.
- Its writes are labelled **interim, pre Change Sets** (decision 400) on the legacy catalog rows; these
  writes are on a separate table and are not interim in that sense.
- Precedent: `catalog/tracking-profile.yaml` is a per-product sub-surface in its own file; RT-1055 placed
  `inventory/low-stock.yaml` in its own file for the same reasons.
- The Admin-Console regenerates its client from a **pinned** commit, so the new file does not move its
  generated types until it re-pins.

Rate-limit classes: `apps/api/test/console-rate-limit/classes/catalog/stock-levels.rate-limit.yaml` (RT-805).
`inventory/low-stock.yaml` gets a description-only alignment (its thresholds now name `product_stock_levels`
and this contract instead of "the store's active override"); no schema, parameter or version change.

## 4. Follow-ups (identified, not created — AC3)

1. **Implementation `[GATED migration]` — `product_stock_levels` migration + the five write/read runtimes
   (Backend-Core).** TH-5 migration with up/down/probe/grant files; schema module; controller, guards, store
   scope, service, audit, 422/409 rules; contract and HTTP integration tests; remove the five operations'
   `x-runtime-status` / `x-runtime-note` markers.
2. **Implementation — runtime of `consoleListLowStock` (Backend-Core)** (RT-1055 follow-up 2): resolve
   thresholds from `product_stock_levels` per TH-3. Blocked by 1.
3. **Admin-Console (later, separate product):** a per-product stock-level editor and the Overview widget,
   after it re-pins to a commit carrying 1 and 2.

## 5. Out of scope

Executing or writing the migration; any runtime; the Admin-Console; per-lot thresholds; sales velocity / days
of cover; multi-unit (Sell Unit) levels; any ERPNext reorder sync.
