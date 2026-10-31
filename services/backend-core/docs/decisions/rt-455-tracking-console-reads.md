# RT-455 — Backend-Core reads for the tracking holds screens and the batch detail: contract proposal

| | |
|---|---|
| **Jira** | RT-455 (F8, Admin-Console). Inputs: RT-972 boards and owner decisions (comment 14943). Related: RT-449 (F2), RT-450 (F3), RT-451 (F4), RT-453 (F6), RT-50 (Gate 7 record, comments 11763–11765). |
| **Work Mode** | Planning (contract-first). Docs only: no production code, contract file, migration, rate-limit class or CI change. |
| **Status** | **Proposed.** Every operation below needs owner approval and an owning issue before any `[GATED]` contract file changes. |
| **Baseline** | `Kemetra-Labs/Retail-Tower-Erp` `origin/main` = `35a0d666` (RT-1039, #199). `inventory.yaml` is `1.8.0-draft`, `catalog/tracking-profile.yaml` is `1.1.0-draft`. |
| **Why docs only** | `packages/contracts/openapi/**` is `[GATED]` (`services/backend-core/CLAUDE.md`). RT-449's approval (c13434) covers its named commands, the feed, the TTL and the findings read only. So the drafts live here as YAML fragments. |

Line references are to `origin/main` at the baseline above.

---

## 0. Summary

| Item | Proposal | Owner |
|---|---|---|
| **TR-2** resolution queue | No design here. **Scope gap:** nothing owns the Tracking Resolution contract (§2). | Owner decision: amend RT-451 with a contract-first step, or open a contract issue that blocks RT-451 |
| **TR-3a** released holds | `listTrackingHolds` (one read, filterable) | New RT-449 follow-up |
| **TR-3b** past recalls | `listInventoryRecalls` (summaries with hold counts) | New RT-449 follow-up |
| **TR-3c** tracking-consistency findings | New reserved finding kind `tracking_consistency` in `listInventorySafetyFindings` | New RT-449 follow-up (contract); RT-451 / RT-453 emit |
| **TR-3d** sold-under-hold and other sale-line findings | A separate paged read with the TR-2 contract, not a kind in the computed list (§3.3) | Same owner as TR-2 |
| **TR-4** actor names | **No new API.** The Console maps `placedBy` / `createdBy` through `listMembers` | RT-455 only (Console) |
| **TR-5** reason codes | `SafetyReasonCode` becomes a fixed enum with `other` + required note | New RT-449 follow-up (contract **and** runtime DTO) |
| **TR-6** tracked-products signal | `getTenantTrackingSummary` in `catalog/tracking-profile.yaml` | New RT-449 follow-up |
| **II-2** stock of one identity | `getTrackingIdentityPositions` | New RT-449 follow-up |
| **II-3** hold history | `listTrackingHolds?trackingIdentityId=` (same read as TR-3a) | New RT-449 follow-up |
| **II-4** expiry-correction history | `listTrackingIdentityExpiryCorrections` | New RT-449 follow-up |
| **II-5** one identity | `getTrackingIdentity` | New RT-449 follow-up |

**Proposed new issue** (not created; the owner decides): *Backend-Core — tracking Console reads and fixed safety reason codes (RT-449 follow-up) [GATED contract]*, under RT-3, Work Mode Implementation, one PR: contract + runtime + tests. It blocks RT-455. RT-449 itself is In Review and its two-PR scope (c13434) is closed, so this is not added to it.

---

## 1. Rules every fragment follows

Taken from `inventory.yaml` 1.8.0-draft as it is on `main`:

- `cookieAuth`, tenant from the session, nothing tenant-, store- or actor-shaped accepted from the request (§XII, FR-052).
- A row of another tenant is a non-disclosing 404 (`NotFoundOrCrossTenant`).
- **Role rule per family, unchanged:**
  - **Identity reads.** `listTrackingIdentities` (line 393) is owner / tenant_admin, and a caller without the role gets a non-disclosing **404**. II-2, II-4 and II-5 follow it.
  - **Hold and recall reads.** `getTrackingHold` (line 824) and `getInventoryRecall` (line 934) are owner / tenant_admin, and other roles get **403**. TR-3a and TR-3b follow them.
  - **Findings.** The findings read keeps its store_manager narrowing (line 758).
- **Keyset pages** follow the RT-731 wording (`listStockMovements`, line 290):
  - a total, stable order on values fixed at write;
  - an opaque `cursor` bound to the operation, tenant and filters;
  - `limit` 1–200, default 50;
  - `nextCursor` required and nullable.
- Projections set `additionalProperties: false`.
- **Contract-only marker.** Every new operation carries `x-runtime-status: contract-only` with an `x-runtime-note` naming its runtime issue, until the runtime ships (CONTRIBUTING.md, RT-805).
- **Rate-limit class.** Each `cookieAuth` operation gets a class in `apps/api/test/console-rate-limit/classes/inventory/inventory.rate-limit.yaml` *in the same PR as the contract*. The intended class is listed per operation below. This record adds no entry, because the ratchet fails on an unknown operation.
- **Versions.** `inventory.yaml` → `1.9.0-draft`; `catalog/tracking-profile.yaml` → `1.2.0-draft`. Everything is additive except TR-5 (§5).
- `InventoryReasonCode` (the RT-435 position-move codes) is not touched. TR-5 changes only `SafetyReasonCode`.

**Reachability.** Nothing writes `tracking_identities` until RT-453 (F6), and nothing writes tracked effects until RT-451. Every read here answers empty, false or 404 until then. That is the same limit RT-449 recorded.

---

## 2. TR-2 — Tracking Resolution queue: mapping to RT-451 only

**What exists:**

- `pos-sales/sales.yaml` (RT-450, merged) documents the G7-9 classification. Its row 4 makes a whole sale `tracking_unresolved`: no Inventory effect and no ERP intent.
- It says the findings surface "through Inventory Health and the Tracking Resolution queue (later issues)", and that "Tracking Resolution is a later contract".
- RT-451 scope item 4 implements Tracking Resolution: a governed, audited, high-sensitivity bind that commits the effects and the intent together (RT-50 DC-2).

**Gap (reported, not resolved here):**

- RT-451's description says "Any OpenAPI change beyond merged F3 is out of scope here".
- RT-450 is Done without that contract.
- RT-50's planning record (comment 11764 §5.2) lists "Tracking Resolution" under the `inventory.yaml` contract changes, but no F-issue was given it.
- So no issue owns the queue read or the bind command. RT-455 scope item 2 cannot be built against a contract until one does.

**Owner decision OD-1: who writes the Tracking Resolution contract.**

- **(a) Recommended:** amend RT-451 so its first PR is contract-only `[GATED contract]` and covers:
  - the queue read;
  - the bind command;
  - the sale-line findings read (§3.3).

  The runtime that produces this data is RT-451's, and RT-451 is blocked by RT-427 anyway, so the contract can merge first without waiting.
- **(b)** Open a contract-only issue ("F3b") that blocks RT-451 and RT-455.

**What the RT-455 board needs from that contract.** These are inputs for its author, not a design:

- **List.** The `tracking_unresolved` sales in the caller's scope, keyset-paged. Per sale: sale id, store, business date, `occurredAt`. Per unresolved line: product, the scanned code if any, the quantity and the reason (no `tracking`, unknown identity, or another product's identity).
- **Bind command.** Per line: the chosen `identityId`, a required reason code and a note. It is idempotent and audited.
- **Roles.** Owner only or owner / tenant_admin. This is a sensitivity choice for RT-451's author (965).
- **Refusals the screen must show:**
  - the identity is not of this product;
  - the identity is held or expired;
  - the sale is already resolved.

---

## 3. TR-3 — findings and history lists

### 3.1 TR-3a and II-3: `listTrackingHolds` (one read serves both)

Released holds for the holds screen, and one identity's hold history for the batch detail. Today a hold can be read only by id, and active holds appear only as findings. Intended class: `cheapRead`.

```yaml
paths:
  /api/inventory/v1/tracking-holds:
    get:
      operationId: listTrackingHolds
      x-runtime-status: contract-only
      x-runtime-note: >
        Proposed RT-449 follow-up (tracking Console reads). Remove both keys
        when the runtime ships.
      tags: [inventory]
      summary: List the tenant's tracking holds, newest first, in keyset pages.
      description: >
        RT-455 TR-3 / II-3 (proposal): the tenant's quality and recall holds,
        active or released, newest first (`placedAt DESC, id DESC`). Filters
        narrow the list and never widen it: `status`, `kind`,
        `trackingIdentityId` (one identity's hold history) and `productId`.
        A filter id that is not of this tenant matches no hold and answers
        an empty page. Keyset pagination as `listStockMovements` (RT-731):
        an opaque `cursor` bound to this operation, the tenant and the
        filters. Holds are tenant-level (RT-449 H2), so the list is not
        store-scoped. Owner or tenant_admin, as `getTrackingHold`; any
        other role is a 403.
      security:
        - cookieAuth: []
      parameters:
        - name: status
          in: query
          required: false
          schema: { type: string, enum: [active, released, all], default: all }
        - name: kind
          in: query
          required: false
          schema: { type: string, enum: [quality_hold, recall_hold] }
        - name: trackingIdentityId
          in: query
          required: false
          schema: { type: string, format: uuid }
        - name: productId
          in: query
          required: false
          description: Tenant Catalog product; lists the holds on its identities.
          schema: { type: string, format: uuid }
        - name: cursor
          in: query
          required: false
          description: >
            Opaque keyset cursor from a prior page's `nextCursor`, bound to the
            operation, the tenant and the filters. A value the server did not
            issue, or one reused with other filters, is 400 `validation_error`.
          schema: { type: string, minLength: 1, maxLength: 1024 }
        - name: limit
          in: query
          required: false
          schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
      responses:
        "200":
          description: A page of holds, newest first.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/TrackingHoldList"
        "400": { $ref: "#/components/responses/ValidationFailure" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/ForbiddenOrOriginRejected" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
        "5XX": { $ref: "#/components/responses/SystemFailure" }
components:
  schemas:
    TrackingHoldList:
      type: object
      additionalProperties: false
      required: [items, nextCursor]
      properties:
        items:
          type: array
          maxItems: 200
          items:
            $ref: "#/components/schemas/TrackingHold"
        nextCursor:
          type: [string, "null"]
          description: Opaque cursor for the next page; null when exhausted.
```

### 3.2 TR-3b: `listInventoryRecalls`

Past recalls for the holds screen. It returns a summary, not `InventoryRecall`: that object embeds up to 100 holds, so a 50-row page could repeat the row blow-up flagged in the RT-449 PR 2 review (c14488, minor 3). The drawer keeps using `getInventoryRecall`. Intended class: `cheapRead`.

```yaml
paths:
  /api/inventory/v1/recalls:
    get:
      operationId: listInventoryRecalls
      x-runtime-status: contract-only
      x-runtime-note: >
        Proposed RT-449 follow-up (tracking Console reads). Remove both keys
        when the runtime ships.
      tags: [inventory]
      summary: List the tenant's recalls, newest first, in keyset pages.
      description: >
        RT-455 TR-3 (proposal): the tenant's recalls as summaries, newest
        first (`createdAt DESC, id DESC`; `effectiveAt` may be backdated, so
        it is not the order key). `productId` narrows to one product; an id
        not of this tenant answers an empty page. Each summary counts its
        holds; `getInventoryRecall` returns them. Keyset pagination as
        `listStockMovements` (RT-731). Owner or tenant_admin, as
        `getInventoryRecall`; any other role is a 403.
      security:
        - cookieAuth: []
      parameters:
        - name: productId
          in: query
          required: false
          schema: { type: string, format: uuid }
        - name: cursor
          in: query
          required: false
          schema: { type: string, minLength: 1, maxLength: 1024 }
        - name: limit
          in: query
          required: false
          schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
      responses:
        "200":
          description: A page of recall summaries, newest first.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/InventoryRecallSummaryList"
        "400": { $ref: "#/components/responses/ValidationFailure" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/ForbiddenOrOriginRejected" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
        "5XX": { $ref: "#/components/responses/SystemFailure" }
components:
  schemas:
    InventoryRecallSummary:
      type: object
      additionalProperties: false
      required:
        [id, tenantProductRef, reasonCode, reference, note, effectiveAt, createdBy, createdAt, holdCount,
         activeHoldCount]
      description: A recall without its holds (`getInventoryRecall` returns them).
      properties:
        id: { type: string, format: uuid }
        tenantProductRef: { type: string, format: uuid }
        reasonCode:
          $ref: "#/components/schemas/SafetyReasonCode"
        reference: { type: string }
        note: { type: [string, "null"] }
        effectiveAt: { type: string, format: date-time }
        createdBy:
          type: string
          format: uuid
          description: The acting principal's user id (an internal actor reference, not PII).
        createdAt: { type: string, format: date-time }
        holdCount: { type: integer, minimum: 1, maximum: 100 }
        activeHoldCount: { type: integer, minimum: 0, maximum: 100 }
    InventoryRecallSummaryList:
      type: object
      additionalProperties: false
      required: [items, nextCursor]
      properties:
        items:
          type: array
          maxItems: 200
          items:
            $ref: "#/components/schemas/InventoryRecallSummary"
        nextCursor:
          type: [string, "null"]
          description: Opaque cursor for the next page; null when exhausted.
```

### 3.3 TR-3c and TR-3d: tracking-consistency and sale-line findings

RT-50 G7-12 lists the Gate 7 health findings. RT-449 (F2) owns only 953 and 954, which are on `main`. Two different kinds of finding remain.

**State findings: tracking consistency (956).** These are current conditions, bounded by the tenant's products and identities, so they fit the unpaged, computed-on-read list. Proposal: one new kind, `tracking_consistency`, with a `check` field. It follows the `expiring_lot` precedent: it is in the `oneOf` now, so clients handle it before it is ever emitted.

| `check` | Condition (RT-50 G7-2 / G7-12) | Data exists from |
|---|---|---|
| `identity_without_edge_map` | An identity with no ERP edge-map row | RT-448 tables; real rows from RT-453 |
| `untracked_effect_on_tracked_product` | An effect with no identity on a product whose mode is not `none` | RT-451 |
| `serial_position_out_of_range` | A serial identity's position outside {0, 1} at a store | RT-451 (serial selling stays off, Q11) |
| `profile_erp_flag_mismatch` | The Catalog profile and the ERP Item flags disagree | RT-452 / RT-453 evidence |

Each `check` is emitted only once its producing runtime ships. The contract says so in the description, as 1.8.0 does for `expiring_lot`.

```yaml
components:
  schemas:
    InventorySafetyFinding:
      # 1.9.0-draft: one more branch and mapping entry; the existing three are unchanged.
      oneOf:
        - $ref: "#/components/schemas/ActiveTrackingHoldFinding"
        - $ref: "#/components/schemas/ExpiredLotSellableFinding"
        - $ref: "#/components/schemas/ExpiringLotFinding"
        - $ref: "#/components/schemas/TrackingConsistencyFinding"
      discriminator:
        propertyName: kind
        mapping:
          active_tracking_hold: "#/components/schemas/ActiveTrackingHoldFinding"
          expired_lot_sellable: "#/components/schemas/ExpiredLotSellableFinding"
          expiring_lot: "#/components/schemas/ExpiringLotFinding"
          tracking_consistency: "#/components/schemas/TrackingConsistencyFinding"
    TrackingConsistencyFinding:
      type: object
      additionalProperties: false
      required: [kind, severity, check, tenantProductRef, trackingIdentityId, storeId]
      description: >
        RT-50 G7-12 (956), reserved in 1.9.0-draft: a tracked product or
        identity whose records disagree. Each `check` is emitted only once the
        runtime that produces its data has shipped (see `check`). A
        store_manager sees a finding only when `storeId` is in its scope;
        a tenant-wide finding (`storeId` null) is owner / tenant_admin only.
      properties:
        kind: { type: string, const: tracking_consistency }
        severity: { type: string, const: critical }
        check:
          type: string
          enum:
            - identity_without_edge_map
            - untracked_effect_on_tracked_product
            - serial_position_out_of_range
            - profile_erp_flag_mismatch
        tenantProductRef: { type: string, format: uuid }
        trackingIdentityId:
          type: [string, "null"]
          format: uuid
          description: Null for `untracked_effect_on_tracked_product` and `profile_erp_flag_mismatch`.
        storeId:
          type: [string, "null"]
          format: uuid
          description: >
            The store of a position check (`untracked_effect_on_tracked_product`,
            `serial_position_out_of_range`); null for a tenant-wide check.
```

**Event findings: sold under hold, unvalidated tracked line, held ERP intent (G7-9 rows 2 and 3).** These record past sale lines, not a current state. Adding them to the unpaged, computed list would make it grow with every such sale and never shrink. RT-450 also reserved them for "Inventory Health and the Tracking Resolution queue (later issues)".

**Owner decision OD-2: where the event findings live.**

- **(a) Recommended:** a separate keyset-paged read, written by the same contract as TR-2 (OD-1). It is filtered by `kind` (`sold_under_hold`, `unvalidated_tracked_line`, `erp_intent_held`) and store, newest first. RT-451 produces the rows. The band then counts only current-state findings (TR-8), and the event list has its own tab.
- **(b)** Reserved kinds in `listInventorySafetyFindings`, limited to a window of business dates. This needs a window policy value, and the list stays unpaged.

`tracking_unresolved` sales are not repeated as findings: they are the TR-2 queue.

---

## 4. TR-4 — actor names: decided against a new API

**Proposal: no name field and no name read.** This matches the owner's TR-7 decision for products and stores:

- The Console resolves `placedBy`, `releasedBy`, `createdBy` and the expiry `createdBy` through the existing `listMembers` (`tenants.openapi.yaml` line 132). It returns `user.id`, `user.display_name` and `user.email`.
- Any member of the tenant can call it, and the screens that show an actor (the hold and recall drawers) are owner / tenant_admin only.
- The inventory contract stays free of personal data (§XIV); its actor fields stay "an internal actor reference, not PII".

**Known limits, for the Console copy:**

- `listForTenant` (`apps/api/src/context/membership.repository.ts`, the `isNull(memberships.revokedAt)` filter) leaves out revoked members.
- So a hold placed by someone whose membership was later revoked does not resolve, and neither does an actor who is not a tenant member, such as a platform support session.
- The Console then shows a neutral fallback label (a message key, UX-12) and never the raw id.

**Owner decision OD-3:** accept this, or ask for a name projection on the hold, recall and correction objects later. That would be a new PII decision, and the work would go to the follow-up issue.

---

## 5. TR-5 — fixed reason codes

The owner decided this on RT-972 c14943: `supplier_notice`, `authority_notice` and `label_misprint`, plus «أخرى» with a required note, fixed in the contract.

```yaml
components:
  schemas:
    SafetyReasonCode:
      type: string
      enum: [supplier_notice, authority_notice, label_misprint, other]
      description: >
        RT-449 / RT-455 TR-5 (owner decision RT-972 c14943): the governed
        reason of a quality hold, a recall or an expiry correction.
        `other` («أخرى») requires a non-empty `note`; without one the
        command is a 400 `validation_error` and nothing is written.
```

**Effects the owner must accept:**

1. **It is a breaking request change.** Today the schema is a free `pattern`; an enum narrows it, and `bc/oasdiff` will very likely report a breaking change. The justification: the commands cannot be reached until RT-453 writes identities, and no client exists (RT-455 is not built).
2. **It cannot be contract-only.** `placeQualityHold`, `createInventoryRecall` and `correctTrackingIdentityExpiry` are routed. The runtime DTO and the `note`-required check must change in the same PR, so this belongs to the follow-up as Implementation, not to a contract-only PR.
3. **Existing rows.** 0072 was never applied to a lab or live database (RT-449 c14364), so no stored code needs mapping. This needs verification in the follow-up against any database where 0072 has since been applied.

**Owner decision OD-4: the expiry-correction list.**

- **Recommended:** the expiry correction uses the same list. A supplier notice or a label misprint is the usual cause of a wrong printed expiry, and `other` covers the rest.
- **Alternative:** a separate `ExpiryCorrectionReasonCode`.

---

## 6. TR-6 — signal that the tenant has tracked products

There is no capability block on `context.openapi.yaml` (it has `getActiveContext` and three switch operations). The fact belongs to Catalog: a product's `tracking_mode`. The proposal is a small Catalog read that store_manager can also call, because the navigation entry is hidden for every role (RT-455 item 5, decisions 967 and 968; TR-1). Intended class: `cheapRead`.

```yaml
# catalog/tracking-profile.yaml 1.2.0-draft
paths:
  /api/v1/catalog/tracking-summary:
    get:
      operationId: getTenantTrackingSummary
      x-runtime-status: contract-only
      x-runtime-note: >
        Proposed RT-449 follow-up (tracking Console reads). Remove both keys
        when the runtime ships.
      tags: [catalog-tracking-profile]
      summary: Whether the tenant has tracked products.
      description: >
        RT-455 TR-6 (proposal; decisions 967, 968): `hasTrackedProducts` is
        true when at least one of the tenant's products that is not retired
        has `tracking_mode` `batch` or `serial`. The Console hides the
        tracking section while it is false. It reads false until tracked
        selling lifts `409 tracking_activation_pending` (RT-451), because
        until then every profile is `none`. Owner, tenant_admin or
        store_manager.
      security:
        - cookieAuth: []
      responses:
        "200":
          description: The tenant's tracking summary.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/TenantTrackingSummary"
        "401":
          description: Caller is not authenticated.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "403":
          description: Authenticated, but not owner, tenant_admin or store_manager.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
components:
  schemas:
    TenantTrackingSummary:
      type: object
      additionalProperties: false
      required: [hasTrackedProducts]
      properties:
        hasTrackedProducts: { type: boolean }
```

**Owner decision OD-5: where the signal lives.**

- **Recommended:** this Catalog read.
- **Alternative:** a field on `getActiveContext`. It saves one request at Console start, but it widens a contract every surface uses.

The responses follow `tracking-profile.yaml`'s own style: inline `Error` responses plus its shared `TooManyRequests`.

---

## 7. Batch or serial detail (II-1 confirmed: one identity)

### 7.1 II-5: `getTrackingIdentity`

Today the page would have to page through `listTrackingIdentities` for the product. Intended class: `cheapRead`.

```yaml
paths:
  /api/inventory/v1/tracking-identities/{identityId}:
    get:
      operationId: getTrackingIdentity
      x-runtime-status: contract-only
      x-runtime-note: >
        Proposed RT-449 follow-up (tracking Console reads). Remove both keys
        when the runtime ships.
      tags: [inventory]
      summary: Read one tracking identity.
      description: >
        RT-455 II-5 (proposal): one batch or serial of the tenant, the same
        projection as `listTrackingIdentities`. Owner or tenant_admin; an
        identity of another tenant, and a caller without the role, is a
        non-disclosing 404 (as `listTrackingIdentities`).
      security:
        - cookieAuth: []
      parameters:
        - $ref: "#/components/parameters/IdentityIdPath"
      responses:
        "200":
          description: The identity.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/TrackingIdentity"
        "400": { $ref: "#/components/responses/ValidationFailure" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFoundOrCrossTenant" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
        "5XX": { $ref: "#/components/responses/SystemFailure" }
```

### 7.2 II-2: `getTrackingIdentityPositions`

`getOnHand` is per product. The detail needs one identity, per store and status. The grain is store × stocking unit, with the six statuses, the same as `OnHand` and the findings. Locations are summed, as in `OnHand`. Intended class: `expensiveRead`, because it aggregates movements.

```yaml
paths:
  /api/inventory/v1/tracking-identities/{identityId}/positions:
    get:
      operationId: getTrackingIdentityPositions
      x-runtime-status: contract-only
      x-runtime-note: >
        Proposed RT-449 follow-up (tracking Console reads). Remove both keys
        when the runtime ships.
      tags: [inventory]
      summary: The derived positions of one identity, per store and status.
      description: >
        RT-455 II-2 (proposal): compute-on-read signed sums of the movements
        that carry the identity, one row per store of the caller's membership
        and stocking unit where the identity has at least one movement,
        ordered by `storeId`. Each row is split into the six inventory
        statuses like `OnHand`, summed over the store's locations. Not
        paginated: bounded by the tenant's stores. Owner or tenant_admin; an
        identity of another tenant, and a caller without the role, is a
        non-disclosing 404.
      security:
        - cookieAuth: []
      parameters:
        - $ref: "#/components/parameters/IdentityIdPath"
      responses:
        "200":
          description: The identity's positions.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/TrackingIdentityPositions"
        "400": { $ref: "#/components/responses/ValidationFailure" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFoundOrCrossTenant" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
        "5XX": { $ref: "#/components/responses/SystemFailure" }
components:
  schemas:
    TrackingIdentityPositions:
      type: object
      additionalProperties: false
      required: [trackingIdentityId, tenantProductRef, stores]
      properties:
        trackingIdentityId: { type: string, format: uuid }
        tenantProductRef: { type: string, format: uuid }
        stores:
          type: array
          items:
            $ref: "#/components/schemas/TrackingIdentityStorePosition"
    TrackingIdentityStorePosition:
      type: object
      additionalProperties: false
      required: [storeId, stockingUnit, quantity, sellableQuantity, statusQuantities]
      properties:
        storeId: { type: string, format: uuid }
        stockingUnit:
          $ref: "#/components/schemas/StockingUnit"
        quantity:
          allOf:
            - $ref: "#/components/schemas/DecimalQuantity"
          description: The physical total over every status and location. May be negative.
        sellableQuantity:
          $ref: "#/components/schemas/DecimalQuantity"
        statusQuantities:
          type: array
          minItems: 6
          maxItems: 6
          description: One entry per inventory status, in `InventoryStatus` order; they sum to `quantity`.
          items:
            $ref: "#/components/schemas/StatusQuantity"
```

**Owner decision OD-6: location grain.**

- **Recommended:** sum over locations, as `OnHand` and the findings do.
- **The catch:** this inherits the netting the RT-449 PR 2 review flagged (c14488, minor 2). +5 at one location and −5 at another read as 0.
- **Alternative:** a per-location breakdown. It is additive later if wanted.

### 7.3 II-4: `listTrackingIdentityExpiryCorrections`

The server keeps the history (`tracking_identity_expiry_corrections`, 0072) but has no read for it. The `GET` sits on the path of the existing `POST`. Intended class: `cheapRead`.

```yaml
paths:
  /api/inventory/v1/tracking-identities/{identityId}/expiry-corrections:
    get:
      operationId: listTrackingIdentityExpiryCorrections
      x-runtime-status: contract-only
      x-runtime-note: >
        Proposed RT-449 follow-up (tracking Console reads). Remove both keys
        when the runtime ships.
      tags: [inventory]
      summary: List an identity's expiry corrections, newest first.
      description: >
        RT-455 II-4 (proposal): the append-only expiry history of one
        identity (RT-449 H7), newest first (`createdAt DESC, id DESC`).
        Keyset pagination as `listStockMovements` (RT-731), the cursor bound
        to the identity. Owner or tenant_admin; an identity of another
        tenant, and a caller without the role, is a non-disclosing 404.
      security:
        - cookieAuth: []
      parameters:
        - $ref: "#/components/parameters/IdentityIdPath"
        - name: cursor
          in: query
          required: false
          schema: { type: string, minLength: 1, maxLength: 1024 }
        - name: limit
          in: query
          required: false
          schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
      responses:
        "200":
          description: A page of corrections, newest first.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/TrackingIdentityExpiryCorrectionList"
        "400": { $ref: "#/components/responses/ValidationFailure" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFoundOrCrossTenant" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
        "5XX": { $ref: "#/components/responses/SystemFailure" }
components:
  schemas:
    TrackingIdentityExpiryCorrectionList:
      type: object
      additionalProperties: false
      required: [items, nextCursor]
      properties:
        items:
          type: array
          maxItems: 200
          items:
            $ref: "#/components/schemas/TrackingIdentityExpiryCorrection"
        nextCursor:
          type: [string, "null"]
          description: Opaque cursor for the next page; null when exhausted.
```

### 7.4 II-3

II-3 is `listTrackingHolds?trackingIdentityId=<id>&status=all` (§3.1). The hero band's "is a hold active" is the same read with `status=active`, so the identity projection gains no hold field.

---

## 8. Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| **OD-0** | Create the RT-449 follow-up issue (§0) that owns §3.1, §3.2, §3.3 (state kind), §5, §6 and §7, as one `[GATED contract]` Implementation PR | Yes |
| **OD-1** | Who writes the Tracking Resolution contract (TR-2) | (a) amend RT-451 with a contract-first PR |
| **OD-2** | Event findings (sold under hold and the rest): a separate paged read, or windowed kinds in the computed list | (a) separate read, with OD-1 |
| **OD-3** | Actor names: no API, the Console uses `listMembers` with a fallback label | Accept |
| **OD-4** | Expiry corrections use the same reason list | Same list |
| **OD-5** | The tracked-products signal as a Catalog read, or a field on `getActiveContext` | Catalog read |
| **OD-6** | Identity positions summed over locations | Sum, as `OnHand` |
| **OD-7** | Accept the breaking request change of TR-5 (no consumer, unreachable until RT-453) | Accept |
| **OD-8** | Severity of `tracking_consistency` | `critical` (each check breaks posting or reconciliation) |

**Needs verification in the follow-up:**

- Whether the keyset orders need new indexes on `tracking_holds` (`tenant_id, placed_at, id`), on the recalls table and on `tracking_identity_expiry_corrections`. A new index is a `[GATED]` migration.
- That 0072 is still unapplied wherever TR-5 would meet stored rows.

## 9. Not in this proposal

- RT-451's runtime, the Tracking Resolution design and the tracked-sale data model.
- TR-9: the POS consumer of the safety feed (RT-454).
- A product or store name read (TR-7, decided: none).
- Any change to RT-449's shipped commands other than TR-5.
