# RT-1317 — Contract draft (proposed diff)

> **Proposed diff only, not applied, and a sketch, not lint-clean OpenAPI.** Mirrors Confluence page
> [73334785](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/73334785) v3, plus this PR's
> review fixes. Slice 1 fills in what a lint needs: a `description` on every response, the
> `{legal_entity_id}` path parameter, B's 404/409/429 responses, `securitySchemes`, C's `openapi`/`info`
> header, where `missing` sits in the error envelope (`error.details.missing`), and
> `store_changed_concurrently` in `updateStore`'s 409 description. No live file under
> `services/backend-core/packages/contracts/openapi/` is edited by RT-1317; PR #485 (RT-1316) is changing `devices.openapi.yaml`
> and `pos-terminal-pairing.openapi.yaml` in parallel. Decision record: [`plan.md`](plan.md).

Diff base: `main` @ `134fbb70f`.

**The `devices.openapi.yaml` part must be rebased on RT-1316,** which is changing that file in parallel (its phase-3 note takes `1.8.0-draft`). Take the next free version when this lands; do not reuse a number written here. The draft follows the owner decisions recorded 2026-11-10 (OD-1 = 1a, OD-3 = 3A). Section G keeps the rejected 3B sketch for the record.

## A. `stores.openapi.yaml`: 1.2.0-draft → next minor (additive)

```yaml
info:
  version: "1.3.0-draft"   # placeholder: next free minor at landing
  description: >
    ... **1.3.0-draft (RT-1317, additive).** Store gains `address`,
    `legal_entity_id` and the read-only `receipt_details`; StoreUpdate and
    StoreCreate accept `address`. An address change writes one
    `store.receipt_details.changed` audit event (before/after, actor).

components:
  schemas:
    ReceiptText:                      # same rule as devices BindingText
      type: string
      minLength: 1
      maxLength: 512
      pattern: '^[^\u0000]*[^\s\u0000][^\u0000]*$'
    Store:
      properties:
+       address:
+         type: [string, "null"]
+         maxLength: 512
+         description: >
+           Store operational address printed on receipts (decision 208).
+           `\n` allowed. Null until set; it cannot be cleared once set.
+       legal_entity_id:
+         type: [string, "null"]
+         format: uuid
+         description: The Legal Entity whose tax registration the store's receipts print.
+       receipt_details:
+         $ref: "#/components/schemas/StoreReceiptDetails"
+   StoreReceiptDetails:
+     type: object
+     additionalProperties: false
+     readOnly: true
+     required: [store_name, address, tax_registration_id, complete, missing, version]
+     description: >
+       What a till paired to this store prints, resolved by Backend-Core:
+       `store_name` from Store.name, `address` from Store.address,
+       `tax_registration_id` from the store's Legal Entity. A code can be
+       issued only when `complete` is true.
+     properties:
+       store_name: { type: string }
+       address: { type: [string, "null"] }
+       tax_registration_id: { type: [string, "null"] }
+       complete: { type: boolean }
+       missing:
+         type: array
+         items: { type: string, enum: [store_name, address, tax_registration_id, legal_entity] }
+         description: >
+           `store_name`: Store.name is blank or longer than 256 characters (the
+           receipt wire limit). `legal_entity`: the store is not linked.
+       version:
+         type: string
+         pattern: '^[0-9a-f]{64}$'
+         description: >
+           Lowercase hex SHA-256 over the canonical resolved values. The POS ETag
+           is this value quoted ("<version>"), as in spec 039.
    StoreCreate:
      properties:
+       address: { $ref: "#/components/schemas/ReceiptText" }
    StoreUpdate:
      description: >
-       At least one of `name`, `is_active` or `timezone`; ...
+       At least one of `name`, `is_active`, `timezone` or `address`; ...
+       `address` and `expected_current_address` travel together; a stale
+       `expected_current_address` is `409 store_changed_concurrently`
+       (decision 270). `address` cannot be null or blank.
      properties:
+       address: { $ref: "#/components/schemas/ReceiptText" }
+       expected_current_address:
+         type: [string, "null"]
+         description: The address the caller edited from (null when unset).
      dependentRequired:
+       address: [expected_current_address]
+       expected_current_address: [address]
```
A rename (`name`) already changes `receipt_details.store_name`, so the Console store screen shows the receipt impact text (decision record §4.6) on name and address edits.

## B. New `legal-entities.openapi.yaml` 1.0.0-draft (option 3A)

```yaml
openapi: 3.1.0
info:
  title: Backend-Core — Legal Entities (receipt tax identity) API
  version: "1.0.0-draft"
  description: >
    RT-1317 option 3A. The minimal Legal Entity (decision 163): one per tenant
    in V1, created by the backfill and by tenant creation. No create or delete
    operation in V1 (one entity per tenant, UNIQUE (tenant_id)); createStore
    links each new store to the tenant's entity on the server, and the M-B
    backfill links existing stores (clients never send legal_entity_id). cookieAuth only; roles owner / tenant_admin of the active
    tenant. A wrong role or another tenant's id is a non-disclosing 404. Every
    operation may return 429 rate_limited (console rate limit).
paths:
  /api/v1/legal-entities:
    get:
      operationId: consoleListLegalEntities
      responses:
        "200": { content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/LegalEntity" } } } } }
  /api/v1/legal-entities/{legal_entity_id}:
    get:
      operationId: consoleGetLegalEntity
    patch:
      operationId: consoleUpdateLegalEntity
      description: >
        Updates `legal_name` and/or `tax_registration_id` when
        `expected_revision` matches (else 409 legal_entity_changed_concurrently).
        A tax-id change re-resolves `receipt_details` of every store of this
        entity and writes one `legal_entity.tax_registration.changed` audit
        event. A tax-id change is refused with
        409 legal_entity_store_has_open_shift while any shift the server
        knows to be open is at a store of this entity (RT-4 answer Q3, 2026-11-10; the decision 214
        pattern). The check and the write run in one transaction.
      requestBody:
        content:
          application/json:
            schema: { $ref: "#/components/schemas/LegalEntityUpdate" }
components:
  schemas:
    LegalEntity:
      type: object
      additionalProperties: false
      required: [id, tenant_id, legal_name, tax_registration_id, revision, store_count]
      properties:
        id: { type: string, format: uuid }
        tenant_id: { type: string, format: uuid }
        legal_name: { type: string }
        tax_registration_id: { type: [string, "null"] }
        revision: { type: integer, minimum: 0 }
        store_count: { type: integer, minimum: 0 }
    LegalEntityUpdate:
      type: object
      additionalProperties: false
      required: [expected_revision]
      minProperties: 2
      properties:
        expected_revision: { type: integer, minimum: 0 }
        legal_name: { type: string, minLength: 1, maxLength: 256 }
        tax_registration_id:
          type: string
          minLength: 1
          maxLength: 64
          pattern: '^[^\u0000]*[^\s\u0000][^\u0000]*$'
          description: >
            Permissive string; format rules belong to the Country Pack
            (decision 1248; RT-4 answer Q5). Cannot be cleared once set
            (RT-4 question Q4 is still open; verify under RT-296).
```

## C. New `pos-store-receipt-profile.openapi.yaml` 1.0.0-draft (refresh read)

This is a separate file so the fixed operation sets named in `pos-terminal-pairing.openapi.yaml` (the RT-327 hint set and the RT-719 build-identity set) are not reopened by this change. Whether the new read joins those sets is decided when it lands.

```yaml
paths:
  /api/pos/v1/store/receipt-profile:
    get:
      operationId: posGetStoreReceiptProfile
      security: [ { device: [] } ]
      description: >
        The paired terminal's store receipt profile. Tenant and store come only
        from the device row; no parameters. Send If-None-Match with the last
        ETag; unchanged returns 304 with no body. A revoked device gets 401 as
        on every device route. The terminal calls it at start and hourly, and
        on 200 replaces branch_name / branch_address /
        tenant_tax_registration_id in terminal_assignment. Sales already
        finalized are never changed. On any error the terminal keeps its
        current copy.
      parameters:
        - { in: header, name: If-None-Match, required: false, schema: { type: string } }
      responses:
        "200":
          headers: { ETag: { schema: { type: string } }, Cache-Control: { schema: { type: string, enum: [no-cache] } } }
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [branch_name, branch_address, tenant_tax_registration_id, version]
                properties:
                  branch_name: { type: string, minLength: 1, maxLength: 256 }
                  branch_address: { type: string, minLength: 1, maxLength: 512 }
                  tenant_tax_registration_id: { type: string, minLength: 1, maxLength: 64 }
                  version: { type: string, pattern: '^[0-9a-f]{64}$' }
        "304":
          description: Unchanged. No body.
          headers: { ETag: { schema: { type: string } } }
        "400": { description: Malformed If-None-Match (validation error envelope, as in spec 039). }
        "401": { description: Device unauthorized (same envelope as other device routes). }
        "409":
          description: >
            store_receipt_details_incomplete. The store's profile is not
            complete (for example a backfill conflict, a store paired with an
            owner-run CLI code, or a store name outside the receipt limit).
            The terminal keeps its copy.
```
The response reuses the pair-response wire names and limits, so the POS writes it to the same columns with the same validation.

## D. `pos-terminal-pairing.openapi.yaml`: 1.6.0-draft → next minor (no wire change)

```yaml
info:
  description: >
+   **Posture (RT-1317).** No wire change. `branch_name`, `branch_address`
+   and `tenant_tax_registration_id` are resolved at consume time from the
+   store's receipt profile (Store.name, Store.address, the store's Legal
+   Entity tax registration), not from the pairing code. Only when the
+   store profile is incomplete (codes issued before the cutover, or by the
+   owner-run bootstrap CLI) does the consume return the code's own snapshot. They are no longer "pinned forever": a terminal
+   with the refresh client updates them through `posGetStoreReceiptProfile`.
+   A terminal without it keeps the pair-time values. Sales keep their own
+   snapshot either way.
  ...
-     - `branch_name`, `branch_address`, `tenant_tax_registration_id`:
-       terminal-resident copies ... The terminal does NOT re-fetch
-       these per sale — they are pinned at pair-time ...
+     - `branch_name`, `branch_address`, `tenant_tax_registration_id`:
+       terminal-resident copies of the store receipt profile. Not fetched
+       per sale: copied at pairing, refreshed by `posGetStoreReceiptProfile`
+       (RT-1317), and copied onto each sale at finalize.
```

## E. `devices.openapi.yaml`: after RT-1316 → next free minor (stage 1), then a later breaking stage 3

```yaml
# Stage 1 (additive for clients; RT-1317 slice 1)
    PairingCodeIssueRequest:
      required:
        - storeId
-       - branchName
-       - branchAddress
-       - taxRegistrationId
      description: >
-       ... Backend-Core holds no store address or tax registration, so the
-       issuer supplies them, as the bootstrap CLI does.
+       ... The receipt details come from the store's receipt profile
+       (`stores.openapi.yaml` `receipt_details`). `branchName`,
+       `branchAddress` and `taxRegistrationId` are deprecated: still
+       accepted (the request stays strict), validated for shape, and
+       ignored. Issuing for a store whose profile is incomplete is
+       `409 store_receipt_details_incomplete`. The server writes the
+       store's resolved profile into the code row's own columns (still
+       NOT NULL until M-C), never the request values.
      properties:
        branchName:    { deprecated: true, ... unchanged shape }
        branchAddress: { deprecated: true, ... }
        taxRegistrationId: { deprecated: true, ... }

  /api/v1/pairing-codes:
    post:
      responses:
        "409":
+         # add to PairingCodeIssueConflict.code enum:
+         #   store_receipt_details_incomplete, with
+         #   `missing: [address | tax_registration_id | legal_entity]`

# Stage 3 (breaking; separate issue after the Console stops sending them)
-       branchName / branchAddress / taxRegistrationId   # removed; a client still
#        sending one gets 400 (strict request). Needs a
#        tools/oasdiff/breaking-ignore.txt line tagged consumer:admin, and an
#        Admin Console repin in a follow-up PR (landing-gated-changes).
```
`PairingCodeIssued` and `PairingCode` list items: no change needed. If the list should show "what this code will print", it can embed `StoreReceiptDetails`; that is optional and not drafted.

## F. Not changed

- `pos-sales/sales.yaml` capture body: the per-sale `branchName`, `branchAddress` and `taxRegistrationId` snapshot stays as is. Backend-Core does not compare it with the current profile.
- `console-sales.openapi.yaml` and `sale-history.yaml`: they keep reading the sale's snapshot.
- Connector contracts: no change.

## G. Option 3B sketch (rejected by OD-3, kept for the record)

```yaml
# tenants.openapi.yaml: Tenant + TenantUpdate gain
tax_registration_id: { type: [string, "null"], maxLength: 64 }   # read
# TenantUpdate.tax_registration_id: string 1..64, non-blank, + expected_revision
# legal-entities.openapi.yaml is then not created; Store.legal_entity_id is dropped;
# a later multi-entity tenant needs a new contract and a migration that moves the
# field (decision 162 conflict). Sections A, C, D and E are otherwise unchanged.
```
