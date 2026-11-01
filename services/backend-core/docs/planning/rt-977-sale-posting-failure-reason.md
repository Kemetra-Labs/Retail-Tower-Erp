# RT-977 — Per-sale ERPNext posting failure reason and repair handle: decision record and contract proposal

> **Status:** decision record + `[GATED]` contract proposal (Work Mode: **Planning**, contract-first, Post-Pilot).
> **Jira holds the live status.** This file records the 2026-11-01 planning pass and is not a status tracker.
>
> No production code, OpenAPI, migration, package or CI change. The contract in §6 is a **proposal**
> described here; it is applied to `packages/contracts/openapi/**` only by Backend-Core slice 1 in §10
> (contract and runtime in one PR), under its own `[GATED]` owner approval.
>
> **Sources:** Jira RT-977 (this item), RT-974 (the state-only banner), RT-410 (backlog `reason` storage, Done),
> RT-1009 / RT-1011 (Console v4.0 sales and sync slices, which exclude this work). `Kemetra-Labs/Retail-Tower-Erp`
> `origin/main` **`0611a85f`**, read-only inspection of `services/backend-core/` and `apps/admin-console/`.
> No runtime was exercised. Paths below are relative to `services/backend-core/` unless they start with `apps/admin-console/`.

---

## 1. The need

When a sale's ERPNext posting fails, the Console sale detail can say only *that* it failed
(`apps/admin-console/src/sales/ErpFailureBanner.tsx:1-12`, RT-974, captain decision 2026-10-30 option A).
RT-977 asks for a contract that lets the sale detail say:

* **why** the posting failed; and
* **where** to repair it,

while the read stays tenant-scoped and safe, and the Console never scans the backlog.

## 2. Verified current state on `origin/main` (`0611a85f`)

### 2.1 Sale detail: `GET /api/v1/sales/{saleRef}` (`consoleGetSale`)

| Fact | Evidence |
| --- | --- |
| `ConsoleSaleDetail.erpPosting` is an `ErpPostingView`: `sale`, `saleDocumentRef`, `reversal`, `reversalDocumentRef`. No reason, no work-item ref. | `packages/contracts/openapi/console-sales.openapi.yaml:645-662`, `:846-847` |
| `ErpPostingState` is `posted / pending / failed / unknown`; `failed` = `permanently_rejected`. | `console-sales.openapi.yaml:470-479`; `apps/api/src/catalog/sales/history/sale-history.projections.ts:26-39` |
| Auth: `cookieAuth` only, `SessionOnlyAdminGuard` → `TenantContextGuard` → `RolesGuard`, roles `owner`, `tenant_admin`, `store_manager`. Every refusal is the same non-disclosing 404; no 403 on this surface. `owner` / `tenant_admin` get their membership store authority (never narrowed by the active store); `store_manager` gets the resolved scope with active-store narrowing. | `console-sales.openapi.yaml:38-67` |
| The sale is read by one scoped query; the posting state comes from `LEFT JOIN erpnext_posting_status` on `(tenant_id, kind, source_ref_id)`: `source_ref_id = sales.id` for the sale, `source_ref_id = sale_voids.id` for the void's reversal. | `apps/api/src/catalog/sales/history/sale-history.reads.ts:58-59`, `:90-94`; `apps/api/src/console-sales/console-sales.service.ts:157-162` |
| `erpPosting.reversal` covers **only the void's reversal** (`source_ref_id` = the `sale_voids` row). That includes a credit-sale **void**: a credit reversal of `kind: "void"` reuses an ordinary `sale_voids` row as its posting's `source_ref_id`. Returns, partial refunds and credit-sale **returns** each write their own `kind = 'reversal'` row with the same `sale_id` and `source_ref_id` = the return, and the detail read shows none of them. | `0019_erpnext_posting_status.sql:43-45`; `apps/api/src/catalog/sales/sale-returns.service.ts:25`; `apps/api/src/catalog/sales/credit-sale-reversal.store.ts:5`, `:87`, `:131` |
| The SQL, the loader and the projection are **shared with the POS sale history** (`sale-history.yaml`). | `console-sales.service.ts:43` imports `SALE_SELECT_SQL`, `loadDetail` from `catalog/sales/history/sale-history.reads` |
| `ErpPostingView` is **pinned identical** to `pos-sales/sale-history.yaml`, and `ConsoleSaleDetail` is pinned to "`SaleHistoryDetail` minus `receiptFacts` / `reprint`, plus `storeTimezone`". | `apps/api/test/console-sales/console-sales.contract.spec.ts:50-64`, `:401-404`, `:418-422`; `packages/contracts/openapi/pos-sales/sale-history.yaml:853` |
| Audit: one `console_sales.detail_read` per authorized open, metadata `sale_ref` + `store_id` only. `Cache-Control: no-store`. | `console-sales.openapi.yaml:141-156`, `:238-281` |

### 2.2 Reconciliation backlog: `GET /api/v1/catalog/erpnext-reconciliation/postings/backlog` (`listPostingBacklog`, spec 017)

| Fact | Evidence |
| --- | --- |
| `PostingBacklogItem` carries `workItemRef`, `kind`, `rejectionCategory` (a documented **string**, not an enum), `saleRef`, `sourceSystem`, `externalId`, `reason`, `deadLetteredAt`, `reconciliationDocumentRef`. | `packages/contracts/openapi/erpnext-reconciliation/reconciliation.yaml:733-849` |
| Filters: `storeId` and `class` only. **No sale filter.** | `reconciliation.yaml:121-150`, `:567-583` |
| `reason` (RT-410) is the Connector's scrubbed message, re-sanitised by Backend-Core, ≤ 1000 chars, **PII-suspect free text**; kept only while the row is dead-lettered; null for Backend-Core-raised dead-letters and pre-0071 rows. Handling: "readable only through this tenant-scoped, cookieAuth read model … shows it only to the roles that can read this backlog". | `reconciliation.yaml:773-827` |
| The same reader rule is in the migration header: "readable only through the tenant-scoped, authenticated 017 read model" (§XIV re-review of 0019). | `packages/db/drizzle/0071_erpnext_posting_rejection_message.sql:30-41` |
| Roles: `owner`, `tenant_admin` only. Audited `erpnext_reconciliation.backlog.listed`; rate-limited `expensiveRead`. | `apps/api/src/catalog/erpnext-reconciliation/erpnext-reconciliation.controller.ts:112-117` |
| Store scope: the caller's membership scope, filtered in SQL; an out-of-scope `storeId` filter is an empty page. The scan is `status = 'permanently_rejected'` ordered by `sequence`; no index serves that status or `sale_id`. | `erpnext-reconciliation.service.ts:20-25`, `:199-245`; `packages/db/drizzle/0019_erpnext_posting_status.sql:129-139` and the later posting-status indexes (0037, 0057-0061: none on `sale_id`) |
| Projection: `reason = rejection_message`, `saleRef = sale_id`. | `apps/api/src/catalog/erpnext-reconciliation/reconciliation-report.projection.ts:50-66` |

### 2.3 Console sync-ops backlog: `GET /api/v1/catalog/erpnext-sync-ops/posting-backlog` (`consoleListPostingBacklog`, spec 025)

`PostingBacklogItem` (025) carries `postingStatusId`, `kind`, `sourceSystem`, `externalId`, `status`,
`rejectionClass`, `deadLetteredAt`. **No `saleRef`, no reason, no repair field** ("repair is a 017 operation").
Roles `owner`, `tenant_admin`. This is what the Console ERP page (`/erp-connection`) reads.
Evidence: `packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml:121-140`, `:431-465`;
`apps/api/src/catalog/erpnext-sync-ops/erpnext-sync-ops.controller.ts:114-116`.

### 2.4 Repair: `POST /api/v1/catalog/erpnext-reconciliation/postings/{workItemRef}/repair` (`repairPosting`)

| Fact | Evidence |
| --- | --- |
| In the contract, `x-idempotency: required`, `Idempotency-Key` required. 201 first record; 200 + `Idempotent-Replayed: true` replay or already-terminal echo; 400, 401, 403 `origin_rejected`, 404 non-disclosing, 409 `idempotency_key_conflict`, 429. | `reconciliation.yaml:152-206`, `:658-684` |
| `RecordedRepair.outcome`: `eligible_again`, `still_failing`, `no_op_echo`; `resolvedDocumentRef` only for an already-posted row. | `reconciliation.yaml:923-952` |
| Roles `owner`, `tenant_admin`. The service writes the `audit_events` row in the same transaction (`erpnext_reconciliation.posting.repaired`, metadata `outcome`, `repair_kind`; no reason). | `erpnext-reconciliation.controller.ts:136-171`; `erpnext-reconciliation.service.ts:446-478` |
| State machine: `posted` → `no_op_echo` with the stored doc ref; `pending` → `no_op_echo`, no re-head; **any other status** (`permanently_rejected`, and also a `failed_transient` row, which is not short-circuited) → re-run 015-RESOLVE → re-offer (`eligible_again`, re-head, `retry_count` reset, clears `rejection_message`) or `still_failing`. | `erpnext-reconciliation.service.ts:262-354` (short-circuits at `:293-299`) |
| RT-332: a `reconciliation_required` dead-letter is **never** re-offered (`still_failing`). | `erpnext-reconciliation.service.ts:357-375` |
| Idempotency runtime: a same-key request while the first is still running gets **425** with `Retry-After: 2` and a non-canonical body; a replay returns the original status (201 or 200) with `Idempotent-Replayed: true`. 425 is not declared in `reconciliation.yaml`. | `apps/api/src/idempotency/idempotency.interceptor.ts:235-247`, `:269-270` |
| Store check: `isStoreWritable` = caller's membership scope **and** a live (`deleted_at IS NULL`) store. | `erpnext-reconciliation.service.ts:663-676`; `apps/api/src/catalog/erpnext-reconciliation/posting-resolution.writer.ts:108-121` |
| `RepairPostingRequest.note` is validated, then **discarded** (`_body`). | `reconciliation.yaml:867-877`; `erpnext-reconciliation.controller.ts:148` |
| **No Console flow calls it.** The Console uses only three other 017 operations. | `apps/admin-console/src/lib/stock-discrepancy-queries.ts:12-70` |

## 3. Read-shape options

The ticket's option (a), "extend `ErpPostingView`", does not survive the evidence: `ErpPostingView` is
pinned identical to the POS sale-history contract (§2.1). Extending it either changes `sale-history.yaml`,
which puts PII-suspect text on a POS path and pulls in the POS contracts-compat gate, or breaks the pin.
So option (a) becomes **(a′): a console-only sibling field on `ConsoleSaleDetail`**, with
`ErpPostingView` left untouched. Option (c) is added because it is the natural alternative to a
role-tiered response.

| | **(a′) console-only `erpPostingFailure` on `ConsoleSaleDetail`** | **(b) `saleRef` filter on `listPostingBacklog`** | **(c) new `GET /api/v1/sales/{saleRef}/erp-posting-failure`** |
| --- | --- | --- | --- |
| Roles | Existing three. Content tiered: `store_manager` gets the category only; `owner` / `tenant_admin` get reason, evidence and repair handle. | `owner`, `tenant_admin` only. `store_manager` gets nothing. | `owner`, `tenant_admin` (route-level `@Roles`). `store_manager` gets nothing. |
| Store scope | Existing `consoleGetSale` scope; the failure probe runs only for a sale that already matched. | 017 membership scope (same rule as the repair). | `consoleGetSale` scope rules, applied again. |
| Tenant isolation | Tenant RLS plus explicit `store_id` predicate, as the detail. | Tenant RLS plus scope filter, as today. | As (a′). |
| Non-disclosure | Unchanged: same 404 cases. A `store_manager` cannot tell "no message" from "withheld" except by the explicit `disclosure` marker, which states its own tier, not the data. | A filter on an out-of-scope sale returns an empty page (no 404), so it does not reveal existence. | Same 404 rules as the detail. |
| Performance | One extra probe, **only when a side is `failed`**: at most two rows through `UQ_idx_erpnext_posting_status_source_ref (tenant_id, source_ref_id)`, the index the detail's joins already use, keyed exactly as those joins (§5). No migration. | A `permanently_rejected` scan with a `sale_id` predicate; no index on either. Every sale-detail open spends an `expensiveRead` rate-limit unit and writes a `backlog.listed` audit row. Second round trip. | One extra request when the state is `failed`; same probe as (a′). Separate audit event and rate-limit class to decide. |
| Contract impact | `console-sales` `1.1.0-draft` → **`1.2.0-draft`**, additive: one new required, nullable response property. `sale-history.yaml` unchanged, so no POS snapshot impact. Pin test widened. `reconciliation.yaml` description-only amendment (reader set, §4). Must ship with its runtime (§10). | `reconciliation.yaml` additive optional query parameter. No reader-rule change. | `console-sales` additive new operation; also edits the exact-paths and `OPERATIONS` pins (`console-sales.contract.spec.ts:44-47`, `:206`) and needs a `console-sales.rate-limit.yaml` class. `reconciliation.yaml` description amendment (reader set). |
| Return / refund / credit-return reversals | Not covered: the detail shows only the void's reversal, credit-sale voids included (§2.1). | **Covered**: a `saleRef` filter returns every dead-letter with that `sale_id`, of any reversal kind. | Could cover them, at the cost of a list shape. |
| RT-410 reader rule | **Widened** to a second cookieAuth read model, same two roles. | **Unchanged**: the honest point in (b)'s favour. | Widened, same two roles. |
| Console | Data arrives with the detail; no new query. | New query keyed by sale; Console calls a 017 surface from the sale page. | New lazy query when the state is `failed`. |

`oasdiff`: adding a response property and adding an operation are additive changes. The contract slice runs
`tools/oasdiff/check.sh` and records the actual result; this pass did not run it. `contracts-compat` (POS
snapshots, `--fail-on WARN`) is untouched by (a′) and (c), because no POS-consumed file changes.

**Recommendation: (a′).** It answers "why" for every role that can open the sale, keeps the Console off the
backlog and its rate-limit class, needs no index, and leaves the POS contract alone. Its one new idea, a
response whose content is tiered by role, is made explicit with a `disclosure` marker rather than left to
silent nulls. If the owner prefers no role-tiered response anywhere, (c) is the fallback (decision D1).
(b) is rejected: it gives `store_manager` nothing, costs an `expensiveRead` unit and an audit row per page
open, and has no index to stand on. Its one real advantage, besides leaving the RT-410 reader rule alone, is
that it also finds failed return, refund and credit-sale return reversals. (a′) leaves those on the
017 / 025 backlogs, matching what `erpPosting` shows today (decision D9); a failed credit-sale void is
shown, because it shares the void's `sale_voids` row.

## 4. Handling the `reason` text

The options are: the closed category only; the stored (already sanitised) reason; or nothing.

**Recommended:** the category for all three roles; the stored reason, unchanged, for `owner` and
`tenant_admin` only, plus a platform-admin session through the `RolesGuard` bypass, which already reads
the 017 backlog today (below).

* **Why not category only.** RT-410 stored the message precisely because the category cannot separate an
  RT-378 representation mismatch, an RT-78 settlement drift, a plain `frappe.ValidationError` and an
  unclassified exception (`validation` and `other` cover them all). Category-only would leave the owner
  where RT-974 left them.
* **Why not to `store_manager`.** RT-410's rule is "only the roles that can read this backlog". Keeping
  the reader set identical means the only widening is *where* it is read, not *who* reads it. That set is
  `owner`, `tenant_admin`, and a human platform-admin session in the tenant's context: `RolesGuard` lets
  a platform admin through every `@Roles` route without a membership match (`apps/api/src/auth/roles.guard.ts:51-59`,
  `:166`), `listPostingBacklog` included. Token principals never get the bypass. The message can embed ERPNext names (accounts, warehouses) a store manager does not see
  elsewhere, and a store manager cannot repair anyway.
* **No second sanitiser at read time.** The text was sanitised on write (`reconciliation.yaml:775-791`); a
  read-time pass would make two copies of one rule drift. The read returns exactly what the backlog returns.
* **The reader-rule amendment.** `reconciliation.yaml` `reason` "Handling" names the 017 read model as the
  only reader. The contract slice amends that paragraph (description only, 1.6.0-draft) to add
  `consoleGetSale.erpPostingFailure` with the same readers, and names the platform-admin bypass explicitly
  (today it is implied by "the roles that can read this backlog"). The 0071 header is an applied migration
  and is not edited; the §XIV re-review is recorded in the contract PR: the classification is unchanged,
  the reader set gains one surface, the readers are unchanged (decision D3).
* **Rules carried to both new readers.** Never logged by Backend-Core (length or hash only); never in
  audit metadata (`console_sales.detail_read` keeps `sale_ref` + `store_id` only); never a metric label;
  never sent to Sentry or Datadog. The Console renders it as plain text, never HTML; never puts it in a
  URL, CSV, Console telemetry (`console-telemetry.openapi.yaml`), an error report or a log.
* **Shared code hazard.** `SALE_SELECT_SQL` / `loadDetail` are shared with the POS sale history. The
  runtime must **not** add `rejection_message` to the shared SELECT. It reads the failure in a separate,
  console-only probe in `console-sales.service.ts`, run only when a side is `failed`.
* **Probe keys (exactly the detail's joins).** Sale side: `kind = 'sale_post' AND source_ref_id = sales.id`.
  Reversal side: `kind = 'reversal' AND source_ref_id = (the sale's sale_voids.id)`, found through
  `uq_sale_voids_one_per_sale` (`0032_sale_returns.sql:25`). Never `sale_id = …`: that has no index and
  would attach a return's or refund's reason and repair handle to the void side. Both keys also carry the
  tenant and an explicit `store_id = <the sale's store>` predicate.

## 5. Repair handle

* **How the Console gets `workItemRef`.** In `erpPostingFailure.sale.repair.workItemRef` (or `.reversal`),
  non-null only when all of these hold:
  1. `disclosure = full` (the session passes the same role predicate as `repairPosting`:
     `owner` / `tenant_admin`, plus the platform-admin `RolesGuard` bypass);
  2. the row's category is not `reconciliation_required` (RT-332: never re-offered);
  3. `isStoreWritable` is true for the sale's store: membership scope **and** a live store. This excludes
     soft-deleted stores, whose history owner/tenant_admin can still read (RT-192) but whose repair is 404.

  Computing (3) with the repair's own function makes the store half correct by construction, including for
  a platform admin, whose scope on the two surfaces this pass did not verify to be identical.
* **The role half is not shared code today.** `repairPosting`'s role gate is `@Roles` inside `RolesGuard`
  (`findRoleCodeForUserInTenant` plus the platform-admin bypass); `ResolvedContext` carries no role, and no
  service-callable predicate exists. The runtime slice extracts one helper that both `RolesGuard`'s
  owner/tenant_admin decision and the detail's `disclosure` use, rather than a second copy of the rule that
  gates the PII-suspect `reason`. (The read uses `SessionOnlyAdminGuard`, repair uses `DashboardAuthGuard`;
  a Console session passes both.)
* **No dead buttons, and no leaks (acceptance tests).** Positive: for every role, store state and category
  in the matrix, a `workItemRef` the read returns is accepted by `repairPosting` for the same session (201
  or 200, never 404). Negative: a `store_manager` on a row with a stored message gets `reason`,
  `reconciliationDocumentRef` and `repair` all null. A platform admin holding a `store_manager` membership
  gets `full`, as `RolesGuard`'s bypass admits it to repair.
* **Stale handle.** A page left open while someone else repairs can send a handle whose row has moved on:
  `posted` → 200 `no_op_echo` with the document ref; `pending` → 200 `no_op_echo`; `failed_transient` →
  201 `eligible_again` or `still_failing` (it is re-offered again, `retry_count` reset; existing 017
  behaviour, §2.4). A 404 means the store was deleted or left the caller's scope, not that the row changed.
  Whether `repairPosting` should no-op on `failed_transient` is a 017 question outside RT-977 (§10, follow-up).
* **Who may repair.** Unchanged: `owner`, `tenant_admin` (`erpnext-reconciliation.controller.ts:143`).
  `store_manager` sees the category and is told who can repair.
* **Idempotency.** The Console mints one `Idempotency-Key` (UUID v4) when the operator confirms, reuses it
  only to retry a transport failure or 5xx of that same confirmation, and mints a new one for any new
  confirmation. Body: `{}` (no `note`: it is discarded server-side and is a PII risk). Single-flight: the
  confirm button is disabled while the request is in flight. A same-key retry that meets the first request
  still running gets 425 (§2.4): keep the key, wait `Retry-After`, retry. Outcome handling is keyed on
  `RecordedRepair.outcome` (and `resolvedDocumentRef`), never on 200 vs 201, because a replay returns the
  original status.
* **Audit.** Unchanged: `repairPosting` writes `erpnext_reconciliation.posting.repaired` in-transaction with
  `outcome` and `repair_kind`. No reason is added. The read writes no new audit event (decision D4).
* **No repair-response change.** `RecordedRepair` already distinguishes every outcome the Console needs (§7).

## 6. Draft OpenAPI fragment (proposal; not applied)

`console-sales.openapi.yaml` → `1.2.0-draft`. Fragment for `components.schemas`:

```yaml
    ConsoleSaleDetail:
      # ... existing properties unchanged ...
      required:
        # ... existing required list ...
        - erpPostingFailure
      properties:
        # ... existing properties ...
        erpPostingFailure:
          description: >
            RT-977 (1.2.0-draft, console-only; not in pos-sales/sale-history.yaml).
            Why a failed ERP posting of this sale failed, and its repair handle.
            Null when neither `erpPosting.sale` nor `erpPosting.reversal` was
            `failed` when the posting rows were read. Covers the same two
            postings as `erpPosting` (the sale and its void's reversal, a
            credit-sale void included); a failed return, refund or credit-sale
            return reversal is not shown here. Read by a separate probe
            after the sale matched the caller's scope: a concurrent repair can
            leave `erpPosting.sale = failed` with `erpPostingFailure.sale = null`
            (or the reverse); a client treats that as "changed, refresh", never
            as an error.
          anyOf:
            - $ref: "#/components/schemas/ConsoleErpPostingFailure"
            - type: "null"

    ConsoleErpPostingFailure:
      type: object
      additionalProperties: false
      required: [disclosure, sale, reversal]
      properties:
        disclosure:
          type: string
          enum: [full, category_only]
          description: >
            What this session may see. `full` for a session that may read the
            017 posting backlog (`owner`, `tenant_admin`, and a platform admin
            through the RolesGuard bypass); `category_only` for `store_manager`.
            Under `category_only`, `reason`, `reconciliationDocumentRef` and
            `repair` are always null. States the caller's tier, never whether a
            message exists.
        sale:
          description: The sale posting's failure; null unless it is dead-lettered.
          anyOf:
            - $ref: "#/components/schemas/ConsoleErpPostingFailureDetail"
            - type: "null"
        reversal:
          description: The void reversal posting's failure; null unless it is dead-lettered.
          anyOf:
            - $ref: "#/components/schemas/ConsoleErpPostingFailureDetail"
            - type: "null"

    ConsoleErpPostingFailureDetail:
      type: object
      additionalProperties: false
      required: [rejectionCategory, deadLetteredAt, reason, reconciliationDocumentRef, repair]
      properties:
        rejectionCategory:
          type: [string, "null"]
          description: >
            The 015 rejection category, read in place: the values documented on
            `erpnext-reconciliation/reconciliation.yaml` `PostingBacklogItem.rejectionCategory`
            (`unmapped_item`, `unmapped_store`, `unmapped_account`, `validation`,
            `closed_period`, `retry_budget_exhausted`, `reconciliation_required`,
            `other`). An open set: a client shows a generic line for a value it
            does not know. Null only if no category was recorded: nullable like
            the column (`0019`) and 025's `rejectionClass`, unlike 017's
            non-null `rejectionCategory`.
        deadLetteredAt:
          type: string
          format: date-time
          description: When the posting became `permanently_rejected` (the 015 row's `updated_at`).
        reason:
          type: [string, "null"]
          maxLength: 1000
          description: >
            Exactly `PostingBacklogItem.reason` (RT-410): the stored, sanitised
            Connector message, with its classification, retention and handling
            rules. Null under `category_only`, and in every case that field is
            null. Plain text; never HTML; never parsed; never logged, audited,
            exported or sent to telemetry.
        reconciliationDocumentRef:
          description: >
            Exactly `PostingBacklogItem.reconciliationDocumentRef` (RT-332): for a
            `reconciliation_required` dead-letter, the existing ERPNext document
            that does not match the intent. Null otherwise and under `category_only`.
          anyOf:
            - type: object
              additionalProperties: false
              required: [doctype, name]
              properties:
                doctype: { type: string, minLength: 1 }
                name: { type: string, minLength: 1 }
            - type: "null"
        repair:
          description: >
            The handle for `erpnext-reconciliation` `repairPosting`. Non-null only
            when `disclosure` is `full`, `rejectionCategory` is not
            `reconciliation_required`, and the sale's store is live and inside the
            caller's membership store scope (the repair's own store rule). Every
            non-null handle is accepted by `repairPosting` for the same session.
            If the row changed in between, the repair answers by its current
            state (200 `no_op_echo`, or 201 `eligible_again` / `still_failing`);
            a 404 means the store was deleted or left the caller's scope.
          anyOf:
            - type: object
              additionalProperties: false
              required: [workItemRef]
              properties:
                workItemRef:
                  type: string
                  format: uuid
                  description: The 015 `erpnext_posting_status.id`; pass to `repairPosting`.
            - type: "null"
```

`reconciliation.yaml` → `1.6.0-draft`, description only: `PostingBacklogItem.reason` "Handling" becomes
"readable only through this tenant-scoped, cookieAuth read model and through
`console-sales` `consoleGetSale.erpPostingFailure`, both limited to `owner` and `tenant_admin`, and to a
human platform-admin session through the `RolesGuard` bypass (never a token principal) …".

Tests that must change with the fragment (all in the one PR of §10):

* `console-sales.contract.spec.ts:418-422`: list the console-only additions (`storeTimezone`,
  `erpPostingFailure`); `ErpPostingView` stays in `SHARED_SCHEMAS` unchanged.
* `console-sales.contract.spec.ts:495-499`: the `DETAIL` and `LEGACY_DETAIL` AJV fixtures gain the field.
* The strictness sweep (`:465-476`) requires every property in `required`, so the field cannot land as
  optional first; the sweep is not weakened.
* `console-sales.http.integration.spec.ts:274`, `:553` validate live detail responses against
  `ConsoleSaleDetail`, so the runtime must emit the field in the same PR.

## 7. Console flow sketch (no UI code)

Banner order stays What → Safety → Action → Evidence (DESIGN.md §8). Copy is proposed; the Console slice
checks it against UX-12 and RT-965 and lists the final keys. Each line names the field that backs it.

**Common lines**

| Line | en | ar | Backed by |
| --- | --- | --- | --- |
| What (sale) | This sale was not posted to ERPNext. | لم تُرحَّل هذه العملية إلى ERPNext. | existing key `sales.erpFailure.sale`; `erpPosting.sale = failed` |
| What (reversal) | The void reversal of this sale was not posted to ERPNext. | لم يُرحَّل عكس إلغاء هذه العملية إلى ERPNext. | existing key; `erpPosting.reversal = failed` |
| Safety | The sale stays recorded in Retail Tower. Repair does not change it. | تبقى العملية مسجّلة في Retail Tower، والإصلاح لا يغيّرها. | the detail read itself; `repairPosting` "the 008 sale fact is NEVER mutated" |
| Evidence (time) | Stopped at {deadLetteredAt}. | توقّف في {deadLetteredAt}. | `deadLetteredAt` |
| Evidence (reason, `full` only) | Message from ERPNext: {reason} | رسالة ERPNext: {reason} | `reason`, plain text, in `<bdi>`; line omitted when null |

No line claims a stock or ledger effect: no field states one.

**Cause line, by `rejectionCategory`**

| Category | en | ar |
| --- | --- | --- |
| `unmapped_item` | An item in this sale has no confirmed ERPNext item mapping. | أحد أصناف هذه العملية ليس له ربط مؤكَّد بصنف في ERPNext. |
| `unmapped_store` | This store has no active ERPNext warehouse mapping. | هذا المتجر ليس له ربط فعّال بمستودع في ERPNext. |
| `unmapped_account` | ERPNext reported a missing account mapping. | أبلغ ERPNext عن ربط حساب غير موجود. |
| `validation` | ERPNext refused the document as invalid. | رفض ERPNext المستند لأنه غير صالح. |
| `closed_period` | ERPNext refused the document: its accounting period is closed. | رفض ERPNext المستند لأن فترته المحاسبية مُقفلة. |
| `retry_budget_exhausted` | Posting stopped after repeated temporary failures. | توقّف الترحيل بعد إخفاقات مؤقتة متكررة. |
| `reconciliation_required` | ERPNext already has a document for this sale ({doctype} {name}) that does not match. Fix it in ERPNext; Retail Tower will not post it again. | يوجد في ERPNext مستند لهذه العملية ({doctype} {name}) لا يطابقها. أصلِحه في ERPNext؛ لن يُرحّلها Retail Tower مرة أخرى. |
| `other`, unknown value, null | ERPNext refused the document. | رفض ERPNext المستند. |

The `reconciliation_required` line shows `{doctype} {name}` only under `full`; under `category_only` it ends
after "does not match.".

**Action, by state**

| State | Shown |
| --- | --- |
| `category_only` (store manager) | "An owner or a tenant admin can repair this posting." / «يمكن للمالك أو لمسؤول المؤسسة إصلاح هذا الترحيل.» No button. (Role labels from `role.owner`, `role.tenant_admin`.) |
| `full`, `repair` non-null | Primary: "Send to ERPNext again" / «أعِد الإرسال إلى ERPNext». Secondary: the existing ERP connection link (`canReadErpStatus`). For `unmapped_item` and `unmapped_store` only (the maps `repairPosting` re-checks): "Fix the mapping first, then send again." / «أصلِح الربط أولًا ثم أعِد الإرسال.» Not for `unmapped_account`: Retail Tower has no account map. |
| `full`, `repair` null, `reconciliation_required` | No button; the ERP connection link only. |
| `full`, `repair` null, other category (deleted store) | No button; no extra copy (the store state is shown elsewhere). |
| `erpPosting` failed, `erpPostingFailure` side null | The RT-974 state-only banner plus "This posting changed. Refresh to see its state." / «تغيّرت حالة هذا الترحيل. حدّث الصفحة لرؤيتها.» |
| Field absent (new Console, old server during a deploy) | Treated as null: the RT-974 banner, unchanged. The generated type marks the field required, so the Console needs an explicit `undefined` guard. |

**Confirmation dialog** (backed by the `repairPosting` description: re-evaluate 015-RESOLVE; O-3, never a
second document):

| Side | en | ar |
| --- | --- | --- |
| Sale | Send this sale to ERPNext again? Retail Tower checks the cause again. If it is fixed, ERPNext receives the sale once; it is never posted twice. | إعادة إرسال هذه العملية إلى ERPNext؟ يتحقق Retail Tower من السبب مرة أخرى. إن كان قد أُصلح، تصل العملية إلى ERPNext مرة واحدة ولا تُرحَّل مرتين أبدًا. |
| Reversal | Send the void reversal of this sale to ERPNext again? Retail Tower checks the cause again. If it is fixed, ERPNext receives the reversal once; it is never posted twice. | إعادة إرسال عكس إلغاء هذه العملية إلى ERPNext؟ يتحقق Retail Tower من السبب مرة أخرى. إن كان قد أُصلح، يصل العكس إلى ERPNext مرة واحدة ولا يُرحَّل مرتين أبدًا. |

**Outcomes** (keyed on `outcome`, not the status code; after any outcome the detail query is refetched)

| Response | en | ar |
| --- | --- | --- |
| 201 `eligible_again` | Sent again. The ERPNext posting is pending. | أُعيد الإرسال. الترحيل إلى ERPNext قيد الانتظار. |
| 201 `still_failing` | Nothing was sent. The cause is still there; fix it, then try again. | لم يُرسَل شيء. السبب ما زال قائمًا؛ أصلِحه ثم حاول مرة أخرى. |
| 200 `no_op_echo`, `resolvedDocumentRef` set | Already posted to ERPNext as {resolvedDocumentRef}. Nothing was sent again. | رُحِّلت بالفعل إلى ERPNext برقم {resolvedDocumentRef}. لم يُرسَل شيء مرة أخرى. |
| 200 `no_op_echo`, no document ref | Already sent again and waiting for ERPNext. Nothing changed. | أُعيد إرسالها بالفعل وهي بانتظار ERPNext. لم يتغير شيء. |
| 404 | This posting can no longer be repaired here. Refresh the sale. | لم يعد إصلاح هذا الترحيل متاحًا هنا. حدّث صفحة العملية. |
| 409 `idempotency_key_conflict` | Generic error; the next confirmation mints a new key. (A client defect, never expected.) | — |
| 403 `origin_rejected` | Generic "request refused, reload" copy (existing keys). | — |
| 429 | Existing rate-limit copy; the button stays disabled until `Retry-After` elapses. | — |
| 425 (same key still running; undeclared in the contract) | No message; keep the key, wait `Retry-After`, retry once more, then show the transport-failure line. | — |
| Transport failure / 5xx | "We could not confirm the result. Try again." Retry reuses the same key. | «تعذّر التأكد من النتيجة. حاول مرة أخرى.» |

## 8. Coordination with RT-973

RT-973 (a sale sync-status ordering field) also changes the `console-sales` read; its planning doc is not on
`main` at `0611a85f`. Both contract slices would:

* bump `console-sales.openapi.yaml` from `1.1.0-draft`; and
* widen the same pin in `console-sales.contract.spec.ts` (console-only additions).

They do not collide on field names (`erpPostingFailure` here). Two workable orders:

1. **Together (recommended if both are approved in the same window and RT-973 can also ship its runtime
   in the same PR):** one `[GATED]` PR takes `1.2.0-draft` with both fields, one pin edit and both runtime
   changes. RT-977's field cannot land contract-first on its own (§10 slice 1), and a combined
   contract-only PR would turn the integration suite red for the same reason.
2. **Separately (the default otherwise):** whichever PR merges first takes `1.2.0-draft`; the second merges
   `origin/main`, takes `1.3.0-draft` and adds its entry to the same console-only list. A trivial conflict,
   no design coupling.

The Console slices are independent of RT-973 either way.

## 9. Owner decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Read shape: (a′) console-only `erpPostingFailure` on the detail, (b) `saleRef` filter on the 017 backlog, or (c) a separate per-sale route. | **(a′)**; (c) if the owner rejects a role-tiered response. |
| D2 | What `store_manager` sees: nothing, or the category and time. | **Category and time** (`disclosure = category_only`). |
| D3 | Widen RT-410's reader rule from "the 017 read model" to also `consoleGetSale`, keeping the readers `owner` / `tenant_admin` plus the platform-admin `RolesGuard` bypass (named explicitly); record the §XIV re-review in the contract PR. | **Yes**, same readers, no store_manager. |
| D4 | Audit the disclosure separately (a flag on `console_sales.detail_read` or a new event)? | **No.** The open is already audited with actor and sale; the reason never enters metadata. |
| D5 | Offer repair on the sale detail for `owner` / `tenant_admin` via `repairPosting`, with the §5 handle rules and §7 outcomes; no `note` field. | **Yes.** |
| D6 | `rejectionCategory` on the new field: a documented open string (as 017 and 025) or a closed enum. | **Open string.** An enum would make every new Connector category a contract change, and adding a response enum value needs an `oasdiff` severity check. |
| D7 | RT-973 coupling: one combined contract PR, or fixed order with `1.3.0-draft` for the second. | **Combined** if both are approved together; otherwise first-merged takes `1.2.0-draft`. |
| D8 | Decision record home: this file as the record (AC1), with a Confluence Decisions entry linking it. | **This file + a short Confluence Decisions entry** written by the coordinator after approval. |
| D9 | Failed return, refund and credit-sale return reversals (a credit-sale void is already in scope through its `sale_voids` row): out of scope for the sale detail (they stay on the 017 / 025 backlogs, as `erpPosting` already ignores them), or in scope (a list-shaped field, or option (b)). | **Out of scope for RT-977**, stated in the contract text; revisit with a separate item if pilots show operators need them on the sale page. |

## 10. Implementation slices this would create (listed, not created)

Each is created only after the owner decisions above, linked to RT-977 with `Blocks`.

1. **Backend-Core contract `[GATED]` + runtime, one PR.** The contract and runtime cannot be split for a
   new required field on a running operation: the integration spec validates live responses against it,
   the strictness sweep forbids an optional first step, and `x-runtime-status: contract-only` marks whole
   operations, not fields (§6). The owner approves the contract part (the §6 fragment and the
   `reconciliation.yaml` `1.6.0-draft` reader-set text) on the PR before it merges, as RT-561 did for its
   contract. Scope:
   * `console-sales` `1.2.0-draft`; `reconciliation.yaml` `1.6.0-draft` (description only); the pin, fixture
     and strictness-compatible test edits of §6; `tools/oasdiff/check.sh` result recorded.
   * Console-only failure probe in `console-sales.service.ts` (shared `SALE_SELECT_SQL` / `loadDetail`
     untouched), run only when a side is `failed`, keyed exactly as §4; `disclosure` from one extracted role
     helper shared with `RolesGuard` (§5); `repair` from `isStoreWritable`.
   * Tests: the role × store-state × category matrix; no-dead-button and the negative `store_manager` case;
     a platform admin with a `store_manager` membership gets `full`; a sale with only a failed return
     reversal gets `erpPostingFailure: null`; a failed credit-sale void appears on the reversal side; a stale `failed_transient` handle; tenant and store isolation
     (404 unchanged); pre-0071 and Backend-Core-raised rows give `reason: null`; POS sale-history response
     unchanged; no log line, audit metadata or metric carries the reason (log scan); concurrent-repair
     mismatch tolerated. No migration.
2. **Admin-Console** — scope:
   * **Client:** repin `apps/admin-console/contracts/backend-core/PIN` (no pinned commit has
     `erpPostingFailure` until slice 1 merges) to a commit containing slice 1 with
     `pnpm generate:client --repin <ref>`, and
     regenerate `src/generated/schema.d.ts`. The generated schema already has `repairPosting`, so the repair
     flow adds a typed wrapper for that existing operation, not a new one.
   * **425:** either the 017 contract declares 425 on `repairPosting` first (the follow-up below), or the
     wrapper gets a focused test proving it can branch on the undeclared 425 and read `Retry-After`.
   * **Screen:** `ErpFailureBanner` gains the cause, reason and action lines (§7); the repair dialog with
     single-flight, per-confirmation `Idempotency-Key`, 425 handling and every outcome keyed on `outcome`;
     an `undefined` guard for the field; ar and en keys; reason never in telemetry, error reports, URLs or
     exports.
   * **Tests:** unit tests per state and outcome; e2e for `full` and `category_only`; axe clean.

   Depends on slice 1 being deployed (until then the field is absent and the RT-974 banner shows).

**Follow-ups outside RT-977, for the coordinator (not created here):** `repairPosting` re-offers a
`failed_transient` row (the contract describes acting on a `permanently_rejected` one); and the 425
`idempotency_in_progress` response is undeclared in `reconciliation.yaml`. Declaring it before slice 2 is
the cleaner of the two options there.

Out of scope, unchanged: the Connector rejection vocabulary, the ERPNext side, the 025 sync-ops backlog,
and the RT-974 state-only banner already shipped.
