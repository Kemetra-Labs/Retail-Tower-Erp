# RT-973 — Sale sync-status ordering field: decision record and contract

> **Status:** decision record (Work Mode: **Planning**, contract-first, Post-Pilot), with the contract-first
> part applied in the same PR as this file. **Jira holds the live status.** This file is not a status tracker.
>
> **Decisions:** every decision below was selected under the owner delegation of 2026-11-02 (captain
> session), as the recommended option. RT-973 was combined with RT-977 in one contract PR (RT-977
> decision D7, recommended option; see `rt-977-sale-posting-failure-reason.md` §11).
>
> **Baseline:** `Kemetra-Labs/Retail-Tower-Erp` `origin/main` **`a43ad962`**, read-only inspection of
> `services/backend-core/` and `apps/admin-console/`. No runtime was exercised. Paths are relative to
> `services/backend-core/` unless they start with `apps/admin-console/`.

---

## 1. The need

The Console reads a sale's `sync_status` from two places and cannot tell which read is newer:

* the sale detail, `GET /api/v1/sales/{saleRef}` (`consoleGetSale`), field `summary.syncStatus`;
* the sale-sync-ops status read `GET /api/v1/catalog/sale-sync-ops/sales/{saleRef}/status`
  (`consoleGetSaleSyncStatus`) and the repair `POST .../sales/{saleRef}/repair` (`consoleRepairSaleSync`),
  both returning `SaleSyncStatus.syncStatus`.

After a confirmed repair, the Console writes the repair's `syncStatus` into the cached detail
(`writeDetailSync`, `apps/admin-console/src/sale-sync/useSaleSync.ts:229-245`). Two edge cases remain (RT-973):

1. If a detail read is in flight, `writeDetailSync` waits for it (`:236`). A read that never settles
   (no client timeout, `retry: false`) keeps the header chip stale until it ends.
2. If that read settles with a newer status (the worker drained the sale in between: `synced`), the
   repair's older `failed-retryable` overwrites it until the next detail read (last write wins).

## 2. Verified current state on `origin/main` (`a43ad962`)

| Fact | Evidence |
| --- | --- |
| `sync_status` is one mutable TEXT column on `sales`; no version, no change time. | `packages/db/drizzle/0026_sale_sync_status.sql:9-19`, `:63` |
| Three writers: the worker drain (`synced`, same UPDATE as `processed_at`); the dead-letter producer (`failed-retryable` / `failed-needs-repair`, guarded `sync_status <> $4`); the console repair. | `apps/worker/src/sales/sale-processing.processor.ts:186`; `apps/worker/src/sales/sale-sync-deadletter.producer.ts:278-284`; `apps/api/src/catalog/sale-sync-ops/sale-sync-ops.read-model.service.ts:405` |
| The detail reads the column through the shared `SALE_SELECT_SQL`; sale-sync-ops reads it with its own `SELECT ... FROM sales`. | `apps/api/src/catalog/sales/history/sale-history.reads.ts`; `sale-sync-ops.read-model.service.ts:446` |
| `SaleSyncStatus.processedAt` is the drain time, set once; it is not a change version (a repair or a dead-letter does not move it). | `packages/contracts/openapi/sale-sync-ops/sale-sync-ops.yaml` `SaleSyncStatus` |
| `ConsoleSaleDetail.summary` is a `ConsoleSaleItem`, pinned to "`SaleHistoryItem` plus `storeRef`". | `apps/api/test/console-sales/console-sales.contract.spec.ts` (shared-vocabulary block) |
| The console-sales strictness sweep requires every property of every object to be `required`, and the HTTP integration spec validates live detail responses against `ConsoleSaleDetail`. | `console-sales.contract.spec.ts` ("every key of every object is required"); `apps/api/test/console-sales/console-sales.http.integration.spec.ts` |
| `SaleSyncStatus` already has an optional property (`processedAt`); no strictness sweep covers `sale-sync-ops.yaml`. The e1 dataset validates fixture bodies against `SaleSyncStatus`, so a new *required* property would need those fixtures changed. | `sale-sync-ops.yaml`; `apps/api/test/ai/eval/e1/e1-dataset.contract.spec.ts:26` |
| The Console has no client timeout convention for reads. | `apps/admin-console/src` (no `AbortSignal.timeout` or equivalent) |

## 3. Decisions

| # | Decision | Selected (owner delegation of 2026-11-02, captain session, recommended option) |
| --- | --- | --- |
| E1 | Add an ordering field, or reject one. | **Add one.** Without it the Console cannot order two reads; the remaining cases are rare but real, and rejecting would leave last-write-wins in place. |
| E2 | Which field: a monotonic integer version or a change timestamp (`syncStatusChangedAt`). | **A monotonic integer, `syncStatusVersion`.** Rationale below. |
| E3 | Owner. | **Backend-Core.** It owns `sales.sync_status` and all three writers. The Console only compares. |
| E4 | Where it appears. | `ConsoleSaleItem.syncStatusVersion` (so `consoleGetSale` `summary` and each `consoleListSales` item) and `SaleSyncStatus.syncStatusVersion` (so `consoleGetSaleSyncStatus` and the `consoleRepairSaleSync` 200). Not on `pos-sales/sale-history.yaml`: the POS does not need it, and it would pull in the POS contracts-compat gate. Not on `NeedsRepairItem`: the queue never writes into the detail cache. |
| E5 | What lands contract-first now. | **`sale-sync-ops.yaml` only, as an optional property** (`1.2.0-draft`). The `console-sales` field cannot land without its runtime (§5), so it lands with slice 1, as RT-977's field does. |
| E6 | Console client timeout on the detail read. | **No timeout.** With the version, the repair write no longer waits for an in-flight read (§6), so edge case 1 disappears without one. A timeout would add an arbitrary constant and a new error state, and would abort slow but valid reads on poor store links. |

**Why an integer, not a timestamp (E2).**

* Ordering must be exact. Two writes in quick succession (a repair, then the drain) can carry equal or
  inverted times: `now()` in PostgreSQL is the transaction start, and the API and the worker commit
  independently. A per-row counter bumped in the same `UPDATE` that sets `sync_status` is ordered by the
  row lock, so a higher value is always the later write.
* Equality must mean "same state". With a counter bumped on every write that sets `sync_status`, two
  reads with the same version carry the same status. A timestamp cannot promise that at its resolution.
* A timestamp is display data; nobody asked to show when the status changed. If that is wanted later, it
  is a separate additive field.

## 4. Contract

### 4.1 Field semantics (both surfaces, identical wording)

`syncStatusVersion` — integer, `minimum: 0`, `maximum: 9007199254740991` (a JSON-safe integer).

* Backend-Core increments it by one in the same statement as every write that sets `sales.sync_status`
  (capture leaves it at 0; the drain, the dead-letter producer and the console repair each add one).
  It never decreases.
* It is comparable only between two reads **of the same sale**. A higher value is a later status; an equal
  value is the same status. It carries no meaning across sales and is not a count of anything the
  operator should read.
* Sales that existed before the column get 0. The first later write moves them to 1.
* An idempotent replay of `consoleRepairSaleSync` returns the stored response, including the version it
  had then. A client comparing versions therefore keeps a newer read over a replay, which is correct.

### 4.2 Applied in this PR: `sale-sync-ops.yaml` `1.1.0-draft` → `1.2.0-draft`

`SaleSyncStatus` gains an **optional** `syncStatusVersion` with the semantics above, and states that
Backend-Core does not emit it yet; the runtime slice (§7, slice 1) emits it on every response and makes
it `required` in the same PR. Adding an optional response property is additive (`oasdiff`, §8), changes
no operation, and needs no `x-runtime-status: contract-only` marker (that marker is per operation, and
every sale-sync-ops operation already ships). The 1.2.0 entry in `info.description` records the change.

A client must treat the field as possibly absent: an older server, or this contract before slice 1.

### 4.3 Deferred to slice 1: `console-sales.openapi.yaml`

`ConsoleSaleItem` gains `syncStatusVersion` (same schema and wording), listed in `required`. This cannot
land contract-first:

* the strictness sweep requires every property to be `required`, so an optional first step fails it, and
  the sweep is not weakened;
* the HTTP integration spec validates live `consoleGetSale` / `consoleListSales` responses, so a
  required property the runtime does not emit turns that suite red;
* `x-runtime-status: contract-only` marks whole operations, and both operations ship.

Slice 1 also widens the pin "`ConsoleSaleItem` is the `SaleHistoryItem` plus `storeRef`" to
"plus `storeRef` and `syncStatusVersion`". With RT-977 combined (D7), the `console-sales` bump is one
`1.1.0-draft` → `1.2.0-draft` carrying both `ConsoleSaleItem.syncStatusVersion` and
`ConsoleSaleDetail.erpPostingFailure`.

### 4.4 Compatibility rules

* **Additive only.** A new response property, never a renamed or retyped one. `oasdiff` must report no
  WARN or ERR.
* **Absent means unknown.** A Console that receives no `syncStatusVersion` (old server, or before slice 1)
  falls back to today's behaviour: it writes the repair status (after the in-flight read, as now).
* **No POS impact.** `pos-sales/sale-history.yaml` does not change; contracts-compat POS snapshots are untouched.
* **Never reused.** The field is never reset or repurposed. If the status vocabulary grows, the counter
  keeps counting.

## 5. Why the two surfaces cannot land together contract-first

See §4.3. The RT-977 record reaches the same conclusion for `erpPostingFailure`
(`rt-977-sale-posting-failure-reason.md` §6, §10 slice 1). So this PR applies only the sale-sync-ops half,
and the decision records state the `console-sales` fragment for slice 1.

## 6. Console reconciliation (specified here, implemented in slice 2)

The merge rule replaces last-write-wins in `writeDetailSync`:

1. On a confirmed repair with a version `r`, write it into the cached detail **at once** (no waiting
   for an in-flight read) when the cached detail has a version `d` and `r > d`.
2. When a detail read settles, keep the higher of the two: if the cached repair write has `r` greater
   than the read's `d`, keep the repair's `syncStatus` and `syncStatusVersion` on top of the read's
   other fields; otherwise take the read whole.
3. If either side lacks the field, use today's behaviour (write after the in-flight read settles).
4. Never mask an errored read, and keep the detail's own freshness time (unchanged from RT-956).

Rule 1 removes edge case 1 (no waiting, so no timeout is needed: E6). Rule 2 removes edge case 2.

## 7. Implementation slices (listed, not created)

Created by the coordinator after review, linked to RT-973 with `Blocks`.

1. **Backend-Core contract `[GATED]` + migration `[GATED]` + runtime, one PR (combined with RT-977 slice 1, D7).**
   * Migration: `ALTER TABLE sales ADD COLUMN sync_status_version BIGINT NOT NULL DEFAULT 0` (constant
     default, no table rewrite) with its `.down.sql`; §XIV classification BUSINESS, as `sync_status`.
   * Every `sync_status` writer adds `sync_status_version = sync_status_version + 1` in the same `UPDATE`
     (worker drain, dead-letter producer, console repair); a test enumerates the writers so a new one
     cannot skip it.
   * Reads: `SALE_SELECT_SQL` and the sale-sync-ops SELECTs return the column. The POS sale-history
     projection does not emit it (its contract does not change).
   * Contract: `sale-sync-ops.yaml` makes `syncStatusVersion` required (e1 fixtures updated);
     `console-sales` `1.2.0-draft` adds it to `ConsoleSaleItem` (pin widened), together with RT-977's field.
   * Tests: monotonic across drain → dead-letter → repair → drain; equal version ⇒ equal status;
     idempotent replay returns the stored version; tenant and store isolation unchanged; POS sale-history
     response unchanged.
2. **Admin-Console reconciliation.** Repin the Backend-Core contract to a commit with slice 1, regenerate
   the client, and implement §6 in `writeDetailSync` / `useRepairSale` with an `undefined` guard; unit tests
   for both edge cases and for the absent-field fallback. No client timeout (E6). Depends on slice 1 being
   deployed (until then the field is absent and today's behaviour stays).

## 8. Validation of this PR

Recorded in the PR body: the contract loader and route-conformance tests
(`apps/api/test/openapi/`), the console-sales and e1 contract specs, the changelog fragment check, and
`tools/oasdiff/check.sh` against the merge-base.
