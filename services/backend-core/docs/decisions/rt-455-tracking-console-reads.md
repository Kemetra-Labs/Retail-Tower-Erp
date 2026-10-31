# RT-455 — Backend-Core reads for the tracking holds screens and the batch detail: contract proposal

| | |
|---|---|
| **Jira** | RT-455 (F8, Admin-Console). Inputs: RT-972 boards and owner decisions (comment 14943). Related: RT-449 (F2), RT-450 (F3), RT-451 (F4), RT-453 (F6), RT-50 (Gate 7 record, comments 11763–11765). |
| **Work Mode** | Planning (contract-first). Docs only: no production code, contract file, migration, rate-limit class or CI change. |
| **Status** | **Proposed.** Every operation below needs owner approval and an owning issue before any `[GATED]` contract file changes. |
| **Baseline** | `Kemetra-Labs/Retail-Tower-Erp` `origin/main` = `35a0d666` (RT-1039, #199), re-checked at `8b4461da` (#200): the contract files are identical. `inventory.yaml` is `1.8.0-draft`, `catalog/tracking-profile.yaml` is `1.1.0-draft`. |
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
| **TR-1** route and navigation | Decided (c14943): its own entry under الكتالوج والمخزون, hidden by TR-6 | RT-455 only (Console) |
| **TR-7** product and store names | Decided (c14943): no API; the Console uses the catalog and store lists | RT-455 only (Console) |
| **TR-8** what the band counts | Decided (c14943): positions, as the server reports them. Nothing to add: the computed list already has one finding per identity × store × unit | RT-455 only (Console) |
| **TR-9** a hold at the POS | Out of scope: the POS consumer of the safety feed | RT-454 |
| **II-1** what the item detail is | Confirmed (c14943): one batch or serial | n/a |

**Proposed new issue** (not created; the owner decides): *Backend-Core — tracking Console reads and fixed safety reason codes (RT-449 follow-up) [GATED contract]*, under RT-3, Work Mode Implementation, one PR: contract + runtime + tests. It blocks RT-455. RT-449 itself is In Review and its two-PR scope (c13434) is closed, so this is not added to it.

---

## 1. Rules every fragment follows

Taken from `inventory.yaml` 1.8.0-draft as it is on `main`:

- `cookieAuth`, tenant from the session, nothing tenant-, store- or actor-shaped accepted from the request (§XII, FR-052).
- A row of another tenant is a non-disclosing 404 (`NotFoundOrCrossTenant`).
- **Role rule per family, unchanged:**
  - **Identity reads.** `listTrackingIdentities` (line 394) is owner / tenant_admin, and a caller without the role gets a non-disclosing **404**. II-2 and II-5 follow it. A role failure is a 404, never a 403: `TrackingIdentitiesController` declares `@Roles('owner', 'tenant_admin')` with `denyAs 404`. So their fragments declare no `403`. The baseline lists `403 Forbidden` (line 420), but that entry does not describe the role failure and is not copied.
  - **Hold, recall and expiry-correction reads.** `getTrackingHold` (line 824), `getInventoryRecall` (line 934) and the expiry-correction `POST` are owner / tenant_admin, and other roles get **403**. That is `denyAs: 403` in `InventorySafetyController`. TR-3a, TR-3b and II-4 follow them. II-4 sits on the same path as that `POST`, so one path never answers a store_manager both 403 and 404.
  - **Findings.** The findings read keeps its store_manager narrowing (line 758).
- **Keyset pages** follow the RT-731 wording (`listStockMovements`, line 290):
  - a total, stable order on values fixed at write;
  - an opaque `cursor` bound to the operation, tenant and filters;
  - `limit` 1–200, default 50;
  - `nextCursor` required and nullable;
  - the RT-731 safety rule (`inventory.yaml` lines 324–332): the cursor carries only a position and a digest of the filters. Its position is ANDed with the tenant and the filters, never replacing them, and the role is checked on every request, never carried by the cursor.
- Projections set `additionalProperties: false`.
- **Contract-only marker.** The fragments carry `x-runtime-status: contract-only`. That is right only if a contract PR lands before its runtime. If the follow-up ships contract and runtime in one PR (OD-0), drop both keys: the route-conformance spec fails on a marked operation that has a route (CONTRIBUTING.md, RT-805). When the markers are kept, `x-runtime-note` names the real issue key once it exists.
- **Rate-limit class.** Each `cookieAuth` operation gets a class in its contract's own file under `apps/api/test/console-rate-limit/classes/`, *in the same PR as the contract*:
  - `inventory/inventory.rate-limit.yaml` for the inventory reads;
  - `catalog/tracking-profile.rate-limit.yaml` for TR-6.

  The intended class is listed per operation below. This record adds no entry, because the ratchet fails on an unknown operation.
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
        filters. The order key is fixed at placement, but `status` is not:
        a hold released during a walk of `status=active` drops out of the
        later pages, so that walk is not guaranteed to reach every hold
        that was active when it started. Conversely, a hold released
        during a walk of `status=released` can enter its later pages, so
        neither status-filtered walk is a complete snapshot of membership
        at its start. Holds are tenant-level (RT-449
        H2), so the list is not store-scoped. Owner or tenant_admin, as
        `getTrackingHold`; any other role is a 403.
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
            Its position is ANDed with the tenant and the filters and never
            replaces them; the role is checked on every request and is never
            carried by the cursor.
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
          description: >
            Opaque keyset cursor from a prior page's `nextCursor`, bound to the
            operation, the tenant and `productId`; a foreign or reused value is
            400 `validation_error`. Its position is ANDed with the tenant and
            the filter; the role is checked on every request.
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

**State findings: tracking consistency (956).** These are current conditions, so they fit the unpaged, computed-on-read list, provided each check has a fixed grain. The grain is the set of fields that makes a finding unique, and it must be bounded by products, identities and stores, never by effects. Proposal: one new kind, `tracking_consistency`, with a `check` field. It follows the `expiring_lot` precedent: it is in the `oneOf` now, so clients handle it before it is ever emitted.

| `check` | Condition (RT-50 G7-2 / G7-12) | One finding per | Data exists from |
|---|---|---|---|
| `identity_without_edge_map` | An identity with no ERP edge-map row | identity | RT-448 tables; real rows from RT-453 |
| `untracked_effect_on_tracked_product` | At least one effect with no identity on a product whose mode is not `none` | product × store × stocking unit (not per effect) | RT-451 |
| `serial_position_out_of_range` | A serial identity's position outside {0, 1} | identity × store × stocking unit | RT-451 (serial selling stays off, Q11) |
| `profile_erp_flag_mismatch` | The Catalog profile and the ERP Item flags disagree | product | RT-452 / RT-453 evidence |

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
      required: [kind, severity, check, tenantProductRef, trackingIdentityId, storeId, stockingUnit]
      description: >
        RT-50 G7-12 (956), reserved in 1.9.0-draft: a tracked product or
        identity whose records disagree, one finding per check grain
        (identity; product × store × unit; identity × store × unit;
        product). Each `check` is emitted only once the runtime that
        produces its data has shipped. A store_manager sees a finding only
        when `storeId` is in its scope; a tenant-wide finding (`storeId`
        null) is owner / tenant_admin only.
      properties:
        kind: { type: string, const: tracking_consistency }
        severity:
          type: string
          const: critical
          description: Proposed value; the owner decides it (OD-8).
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
        stockingUnit:
          oneOf:
            - $ref: "#/components/schemas/StockingUnit"
            - type: "null"
          description: The stocking unit of a position check; null for a tenant-wide check.
```

**Event findings: sold under hold, unvalidated tracked line, held ERP intent (G7-9 rows 2 and 3).** These record past sale lines, not a current state. Adding them to the unpaged, computed list would make it grow with every such sale and never shrink. RT-450 also reserved them for "Inventory Health and the Tracking Resolution queue (later issues)".

**Owner decision OD-2: where the event findings live.**

- **(a) Recommended:** a separate keyset-paged read, written by the same contract as TR-2 (OD-1). It is filtered by `kind` (`sold_under_hold`, `unvalidated_tracked_line`, `erp_intent_held`) and store, newest first. RT-451 produces the rows. The band then counts only current-state findings (TR-8), and the event list has its own tab.
- **(b)** Reserved kinds in `listInventorySafetyFindings`, limited to a window of business dates. This needs a window policy value, and the list stays unpaged.

**`tracking_unresolved` sales are not repeated as findings: they are the TR-2 queue.** This is a deliberate change from merged `sales.yaml` (lines 628–641). That file says a row-4 sale raises a critical finding that surfaces "through Inventory Health and the Tracking Resolution queue".

The consequence is store_manager visibility. If the queue is owner / tenant_admin only (§2), a store_manager's health view never shows an unresolved tracked sale at its own store.

**Owner decision OD-9: how the row-4 finding surfaces.**

- **(a) Recommended:** keep the queue as the only surface, and let a store_manager see a count-only line for its own stores. The count comes from the queue read itself, narrowed like the findings read.
- **(b)** Add a `tracking_unresolved_sale` kind to the computed list, one per sale. A sale leaves it when it is resolved, so the list stays bounded by the backlog.

---

## 4. TR-4 — actor names: decided against a new API

**Proposal: no name field and no name read.** This matches the owner's TR-7 decision for products and stores:

- The Console resolves `placedBy`, `releasedBy`, `createdBy` and the expiry `createdBy` through the existing `listMembers` (`tenants.openapi.yaml` line 132). It returns `user.id`, `user.display_name` and `user.email`.
- It is owner / tenant_admin only: `tenants.controller.ts` declares `@RolesFromParam("id", "owner", "tenant_admin")`, and any other role gets a 404. The screens that show an actor (the hold and recall drawers) are also owner / tenant_admin only, so the read is available wherever it is needed.
- The inventory contract stays free of personal data (§XIV); its actor fields stay "an internal actor reference, not PII".

**Known limits, for the Console copy:**

- `listForTenant` (`apps/api/src/context/membership.repository.ts`) filters out:
  - revoked memberships (`revokedAt`);
  - deleted memberships (`deletedAt`);
  - deleted users (`users.deletedAt`).
- So a hold placed by someone who has since left the tenant does not resolve, and neither does an actor who was never a tenant member, such as a platform support session.
- The Console then shows a neutral fallback label (a message key, UX-12) and never the raw id.

**Owner decision OD-3:** accept this, or ask for a name projection on the hold, recall and correction objects later. That would be a new PII decision, and the work would go to the follow-up issue.

---

## 5. TR-5 — fixed reason codes

The owner decided this on RT-972 c14943: `supplier_notice`, `authority_notice` and `label_misprint`, plus «أخرى» with a required note, fixed in the contract.

**Where the note rule lives.** The list is a schema enum. The "note required with `other`" rule is stated in the description and enforced by the runtime as a 400. This follows the convention `inventory.yaml` already uses for `createStatusMove`'s `correction` note: no `if`/`then` in the schema. A schema conditional could not reject a whitespace-only note anyway, and the runtime turns such a note into null.

The enum applies to **commands only**. Projections keep the existing pattern, so a row written under the 0072 pattern still reads back. `SafetyReasonCode` stays as it is and is used by `TrackingHold`, `InventoryRecall`, `InventoryRecallSummary` and `TrackingIdentityExpiryCorrection`. A new `SafetyReasonCodeInput` is what the three commands accept.

```yaml
components:
  schemas:
    SafetyReasonCodeInput:
      type: string
      enum: [supplier_notice, authority_notice, label_misprint, other]
      description: >
        RT-449 / RT-455 TR-5 (owner decision RT-972 c14943): the governed
        reason a command accepts for a quality hold, a recall or an expiry
        correction. `other` («أخرى») requires a non-empty `note`; without
        one the command is a 400 `validation_error` and nothing is written.
        Projections keep `SafetyReasonCode` (the pattern), so a recorded
        code outside this list still reads back.
    PlaceQualityHoldCommand:
      properties:
        reasonCode:
          $ref: "#/components/schemas/SafetyReasonCodeInput"
    CreateInventoryRecallCommand:
      properties:
        reasonCode:
          $ref: "#/components/schemas/SafetyReasonCodeInput"
    CorrectTrackingIdentityExpiryCommand:
      properties:
        reasonCode:
          $ref: "#/components/schemas/SafetyReasonCodeInput"
```

These are partial overrides: only `reasonCode` changes in each command.

**Effects the owner must accept:**

1. **It is a breaking request change, and only a request change.** Today the command schema is a free `pattern`; the enum narrows it, and `bc/oasdiff` will very likely report a breaking change. Response schemas do not change.
   - The justification: the three commands are routed, but each answers 404 until RT-453 writes identities, because there is nothing to act on. No screen calls them yet (RT-455 is not built).
   - The Console's generated types already carry `SafetyReasonCode: string` (`apps/admin-console/src/generated/schema.d.ts`). They are regenerated with the contract.
2. **It cannot be contract-only.** `placeQualityHold`, `createInventoryRecall` and `correctTrackingIdentityExpiry` are routed, so this belongs to the follow-up as Implementation, not to a contract-only PR. Two runtime rules change in the same PR:
   - the DTO enum;
   - the "non-empty note with `other`" check. It is a runtime rule because `SafetyNote` has no `minLength`.
3. **No migration.** The 0072 `CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$')` constraints (`0072_inventory_safety.sql` lines 185, 263, 370) already admit all four values and stay as they are.
4. **Existing rows.** Keeping the pattern on projections means no stored code breaks a read. The follow-up still lists the distinct `reason_code` values in `tracking_holds`, `inventory_recalls` and `tracking_identity_expiry_corrections` on every database where 0072 is applied, and attaches the result as evidence. Per RT-449, 0072 was never applied to a lab or live database (RT-449 c14364), so no stored code needs mapping. This needs verification in the follow-up against any database where 0072 has since been applied.

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

**This changes the file's stated rule, deliberately.**

- The responses follow `tracking-profile.yaml`'s own style: inline `Error` responses plus its shared `TooManyRequests`.
- The roles do not follow it. The file's info block says owner / tenant-admin only, a non-disclosing 404 on a missing role, and "Two operations".
- This read admits store_manager and answers other roles 403, because it is a tenant-level read with no path id: there is nothing whose existence a 404 would hide.
- Applying it therefore also amends the info block: three operations, and a per-operation role rule. The rate-limit entry goes in `catalog/tracking-profile.rate-limit.yaml`.

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
        to the identity. Owner or tenant_admin, like the `POST` on this path
        (`InventorySafetyController`, `denyAs: 403`): any other role is a
        403. An identity of another tenant is a non-disclosing 404.
      security:
        - cookieAuth: []
      parameters:
        - $ref: "#/components/parameters/IdentityIdPath"
        - name: cursor
          in: query
          required: false
          description: >
            Opaque keyset cursor from a prior page's `nextCursor`, bound to the
            operation, the tenant and the identity; a foreign or reused value
            is 400 `validation_error`. Its position is ANDed with the tenant
            and the identity; the role is checked on every request.
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
        "403": { $ref: "#/components/responses/ForbiddenOrOriginRejected" }
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
| **OD-7** | Accept the breaking request change of TR-5 (no consumer; the routed commands answer 404 until RT-453 writes identities) | Accept |
| **OD-8** | Severity of `tracking_consistency` | `critical` (each check breaks posting or reconciliation) |
| **OD-9** | How a `tracking_unresolved` sale surfaces, since it is not a finding: a deliberate change from `sales.yaml`, which affects store_manager visibility | (a) the queue, plus a count-only line for a store_manager's own stores |

**Needs verification in the follow-up:**

- Whether the keyset orders need new indexes on `tracking_holds` (`tenant_id, placed_at, id`), on the recalls table and on `tracking_identity_expiry_corrections`. A new index is a `[GATED]` migration.
- That 0072 is still unapplied wherever TR-5 would meet stored rows.

## 9. Not in this proposal

- RT-451's runtime, the Tracking Resolution design and the tracked-sale data model.
- TR-9: the POS consumer of the safety feed (RT-454).
- A product or store name read (TR-7, decided: none).
- Any change to RT-449's shipped commands other than TR-5.
