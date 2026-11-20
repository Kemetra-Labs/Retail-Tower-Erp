# Spec 049 — Manual-first product import (CSV / XLSX): upload, map, validate, preview, publish

| | |
|---|---|
| **Jira** | RT-1489 (W1, Epic RT-1). Planning, horizon Post-Pilot (owner decision 4, RT-1478 comment 17637: plan now, build post-pilot) |
| **Work Mode** | Planning. This folder is the deliverable. No OpenAPI, migration, runtime, package, lockfile or CI file is changed |
| **Primary repository** | `Kemetra-Labs/Retail-Tower-Erp`, `services/backend-core/` (the authority). Consumer: `apps/admin-console/` |
| **Baseline** | `origin/main` @ `f30c5de34` (2026-11-19) |
| **Decisions honoured** | Confluence RETAIL 23461894 (Catalog 276–460), especially 416–423 (imports), 301–319 (identifiers), 392–394 (lifecycle), 400–408 (Change Sets), 445–450 (Console, bulk actions). 83329059 (product acquisition, methods 1–3, §4, §7 "Direct/core", §8). 84050068 CR01, CR06, CR16. RT-281 O-1, O-2, O-5 (comment 14125). RT-827 PD-1..PD-9 (comment 15253) |
| **Decision record** | [decision-record.md](decision-record.md): OD-1 to OD-17, each with options and a recommendation. **All accepted as recommended** by the owner on 2026-11-19 (RT-1489 comment 17790); the accepted value of each is in the decision record |
| **Status** | ACCEPTED (owner decisions OD-1..OD-17, 2026-11-19). Plan merged in PR #711; slices S1–S9 created as RT issues (§12); the S1 contract is `catalog/catalog-import.yaml` (RT-1502). The OD-14 re-check at S2's Definition of Ready kept the interim tables (§9.1, RT-1503) |

## 1. Objective

A merchant onboards or refreshes a product catalogue from a spreadsheet instead of typing every item:
**Upload → Map → Validate → Preview → Publish** (decision 416), CSV and XLSX first (417), with explicit
**Create / Update / Upsert** modes (418), **no silently skipped row** (419), deterministic matching (420), a
review step instead of any auto-merge (421), no external authority (422) and batch provenance (423).

It is method 3 of the six acquisition methods (83329059 §2). Method 1 (manual entry) already has its API
(`consoleCreateCatalogProduct`); its Console create form is carried by RT-1493 item C-1. Method 2 (manual supplier
invoice) is W2 purchasing and is out of scope; §11 names the part of this design it can reuse later.

## 2. What exists on `main` today (verified on `f30c5de34`)

| # | Fact | Evidence |
|---|---|---|
| F-1 | **No import exists** anywhere: no import table, contract, route, worker job or Console screen. No CSV or XLSX parser is a dependency of Backend-Core or Admin Console (`multer` appears only as a `pnpm.overrides` pin of the transitive `@nestjs/platform-express` dependency). | grep of `services/backend-core/{apps,packages}`, `apps/admin-console/src`; `services/backend-core/package.json:44` |
| F-2 | The **console catalogue write API** (RT-738, RT-1334) is served: create product (`Idempotency-Key`), update (`expectedUpdatedAt`), retire, add / retire identifier, upsert / retire store override, create / rename brand. Roles `owner`, `tenant_admin` (and `store_manager` for a store's availability). Every accepted write appends one `audit_events` row in its transaction. | `packages/contracts/openapi/catalog/console-catalog.yaml` 1.2.0-draft; `apps/api/src/catalog/console-catalog/console-catalog.write.service.ts` |
| F-3 | **No write sets a price** (O-2, PD-2). A product's first price comes only through the Pricing change sets (specs 042 / 044), whose runtime is RT-1484 and cutover RT-1485, both To Do. RT-827 (Console create) was closed administratively, not built, and is carried to RT-1493 C-1. | `console-catalog.yaml` "Out of scope of every write"; RT-827 comments 15253, 17734 |
| F-4 | **The POS read-down omits an unpriced product** and records it to the unpriced-issue signal. A product created without a price exists in the Tenant Catalogue but is not sellable at any till. | `packages/contracts/openapi/catalog/read-down.yaml:35,119` |
| F-5 | **Identifiers** (`product_aliases`): types `barcode`, `sku`, `plu`, `supplier_code`, `external_pos_id`. Unique among active identifiers in scope (tenant-wide by type + value; store-scoped by store + type + value; `external_pos_id` by source system + value). Stored and compared byte for byte, leading zeros significant, no trimming or case folding. Adding an active one is `409 alias_conflict`. Moving an identifier is not a write (decision 317). | `packages/db/src/schema/catalog/product-aliases.ts`; `console-catalog.yaml` "Identifiers" |
| F-6 | **Product fields**: `name` (1–500), `description` (≤ 2000 in the contract), `category_id`, `brand_id`, `tax_category` (free text 1–50, required), `is_active`, `tracking_mode` / `expiry_required` (own surface, `tracking-profile.yaml`), `default_price` / `default_currency_code` (legacy, not writable), `source_global_product_id`, `correlation_id`. | `packages/db/src/schema/catalog/tenant-products.ts` |
| F-7 | **Categories cannot be created through any API**: only the seed CLI inserts them. Their names are unique among the tenant's active (not retired) categories. **Brands can** (`consoleCreateCatalogBrand`), unique among a tenant's active brands by exact name. | `packages/db/src/cli/seed-catalog.ts:216`; `tenant-product-categories.ts`; `console-catalog.yaml` "Brands" |
| F-8 | **No Change Set primitive exists.** Spec 042 §9 defines the shared domain-neutral `change_sets` primitive (`domain` = `pricing`, later `catalog`); O-5 approved one shared Catalog + Pricing publish/revision engine; PM-5 maps to RT-484 (spec 042, Done), whose runtime is RT-1484 (To Do). | `specs/042-price-change-set-lifecycle/plan.md` §9; RT-281 comments 14125, 14154 |
| F-9 | **Upload precedent**: tenant logo (spec 039 OD-14) sends a raw byte body under any `Content-Type`, checks magic bytes, needs no multipart parser; bytes live in Postgres `bytea` (OD-1), no object store exists. Its routes keep the JSON body parsers off and read the raw body themselves (`tenant-branding/logo-body.ts`); they carry no `Idempotency-Key`. Large bodies follow RT-1284 / RT-1295: a route-scoped limit, read only after the route's guards pass on headers alone, with a concurrency bound. | `specs/039-tenant-logo-branding/spec.md` FR-03, FR-04, OD-1, OD-14; `apps/api/src/tenant-branding/logo-body.ts`; `apps/api/src/common/json-body-limits.ts` |
| F-10 | **Shared machinery to reuse**: the `Idempotency-Key` interceptor (`apps/api/src/idempotency/`, table `idempotency_keys`), `audit_events`, the `catalog_change_log` triggers that feed the POS delta, the console rate-limit classes (`apps/api/test/console-rate-limit/classes/catalog/`), the operator store-scope rule, FORCE RLS tenant context, the per-tenant advisory-lock precedent (`lockPostingFeedSequence`, `tenantLogoLockKey`). | paths named |
| F-11 | **Admin Console** has catalogue list, detail, edit, identifier add / retire and store-override screens under `src/catalog/`, plus `ConfirmModal`, `FailureBanner`, `ImpactList` and `useServerRead` for force-with-preview flows. It has a CSV **download** helper (`src/sales-daily/downloadCsv.ts`) and one **file upload**: the tenant logo field (`src/branding/LogoUploadField.tsx`, `<input type="file">` in `TenantBrandingPage.tsx`), which sends a raw `application/octet-stream` body (`src/lib/tenant-branding-queries.ts`). | `apps/admin-console/src/catalog/*`, `src/branding/*`; ux-pos-console `console.md` |

## 3. Official first — Reuse before build

```
Official capability / docs + version: ERPNext / Frappe v16 "Data Import" DocType (Import Type "Insert New Records" |
  "Update Existing Records"; CSV / XLSX / Google Sheets; template export; preview with warnings; background job;
  import log; failed-rows export) — https://docs.frappe.io/framework/user/en/guides/data/import-large-csv-file and the
  Frappe core DocType `data_import`. NestJS file upload (FileInterceptor / multer) — docs.nestjs.com/techniques/file-upload.
  Parsers: csv-parse 7.0.3 (node-csv), read-excel-file 9.3.17, ExcelJS 4.4.0, SheetJS `xlsx` on npm frozen at 0.18.5
  (npm registry, read 2026-11-19). Documentation only; no runtime proof was gathered.
Existing Retail Tower implementation: console-catalog write service and contract (F-2); identifier rules (F-5);
  Idempotency-Key interceptor, audit_events, catalog_change_log, rate-limit classes, RLS (F-10); spec 039 raw-body upload
  and bytea precedent (F-9); spec 042 §9 shared change_sets primitive, planned not built (F-8).
Decision: EXTEND, with one bounded BUILD (the import staging module).
Why: ERPNext Data Import cannot be reused: it writes ERPNext DocTypes (Item), not the Backend-Core Tenant Catalogue
  (276, 282, 422, CR01); the Console must not call ERPNext; it has no Upsert, no tenant identifier registry semantics
  (byte-exact, scoped, fail-closed 311) and no ambiguity review (421). Its interaction pattern (template, insert vs
  update, per-row log, failed-rows file) is borrowed. The product writes EXTEND the existing console-catalog domain
  service (same validation, audit, change-log and RLS), called in-process inside one publish transaction, not over HTTP.
  The upload EXTENDS the spec 039 raw-body pattern on both sides (Backend-Core `logo-body.ts`, Console
  `LogoUploadField`). The BUILD is the staging batch (file → rows → mapping → validation
  → review → publish), which exists nowhere on main; when the shared change_sets primitive (RT-1484) exists, the batch
  becomes a `catalog`-domain change set instead of a parallel lifecycle (§9, OD-14).
Safety: Backend-Core owns validation and publish (445, 446); Console is UI only; no ERPNext / Connector call; no price
  write (O-2, PD-2); no identifier move (317); tenant RLS on every new table; gated paths listed in §12.
```

## 4. Scope

### 4.1 In V1

- One file per batch: CSV (UTF-8) or XLSX (first sheet or one chosen sheet), header row required.
- Tenant-level product fields and tenant-wide identifiers only (§5).
- Modes Create, Update, Upsert, chosen once per batch.
- Column mapping with saved per-tenant mapping profiles (Arabic and English header synonyms).
- Row validation, an in-batch review queue for ambiguous or doubtful rows, a preview with impact, and one atomic publish.
- An error report file (CSV) the merchant downloads and reads. The report is read-only and is never re-uploaded: the
  merchant fixes the **source file** and re-uploads that. Cells the report guards against formula injection carry a
  leading `'`, so a value copied from the report would not match (identifiers are byte-exact).
- Audit and provenance for every batch, every decision and every product change.

### 4.2 Not in V1 (seam kept)

| Excluded | Why / where it goes |
|---|---|
| Writing any price | O-2, PD-2. Price columns are recognised and never written (§6, OD-2). After RT-1484 / RT-1485 a later slice turns them into a **draft** Price Change Set (S9) |
| Store overrides, store availability, store-scoped identifiers | Store authority and store scope (361, 449) add a second permission model to every row; OD-4 |
| Tracking profile, expiry requirement, capabilities, units, packs, variants, families | Tracking changes are impact operations (387); units / packs / variants are not modelled on `main` (F-6) |
| Retiring, un-retiring or deleting products; retiring or moving identifiers | 317, 394; the import never retires, deletes or moves anything. The one way it can take a product off the tills is `is_active = false` on Update, which the preview states explicitly (OD-17) |
| Creating categories | No category write exists (F-7); OD-3 |
| Supplier codes, supplier terms, purchase prices, quantities, invoice numbers | W2 purchasing and W3 inventory (83329059 §4; 364–371, 456) |
| OCR / AI invoice extraction, supplier feeds / APIs, Global Product Index adoption | Methods 4–6, phased or conditional (83329059 §7) |
| Any ERPNext / Connector write | 282, 439–444: ERP mapping stays its own confirmed path; a missing mapping is a reconciliation gap (441) |
| Background jobs, scheduled publish (406), approval workflow (404) | V1 is synchronous within the §8 limits (OD-7); approval waits for the policy engine (OD-12) |

## 5. Field contract (per row)

A column is **mapped** to one canonical field or explicitly **ignored**. An unmapped column is never silently dropped:
the mapping step lists it, and the merchant confirms "ignore" (419). Each canonical field appears at most once, except
`barcode`, which may be mapped from up to 5 columns.

| Canonical field | Type and rule | Create | Update | Maps to |
|---|---|---|---|---|
| `sku` | Identifier value: 1–200 chars, no control char, no leading/trailing whitespace (F-5 pattern); byte-exact | Recommended; it is the stable key (OD-1) | Match key | `product_aliases` type `sku`, tenant-wide |
| `barcode` (×1..5) | Identifier value as above; digits-only values of length 8 / 12 / 13 / 14 are GTIN-checked (warning, OD-16) | Optional | Match key; a new value is added | type `barcode`, tenant-wide |
| `plu` | Identifier value as above | Optional | Match key; added if new | type `plu`, tenant-wide (store-scoped PLU excluded) |
| `name` | 1–500 chars, at least one non-whitespace, no NUL | **Required** | Optional (blank = unchanged) | `tenant_products.name` |
| `description` | 1–2000 chars, no NUL | Optional | Optional | `description` |
| `category` | Exact name of an existing, not retired category of the tenant (no case folding) | Optional | Optional | `category_id` |
| `brand` | Exact name of an active brand of the tenant; missing brand per OD-3 | Optional | Optional | `brand_id` |
| `tax_category` | 1–50 chars, at least one non-whitespace, no NUL; a value the tenant has never used is a **warning** (likely typo; free text on `main`) | **Required** | Optional | `tax_category` |
| `is_active` | One of `true`/`false`, `1`/`0`, `yes`/`no`, `نعم`/`لا` | Optional, default `true` | Optional; `false` takes the product off every till (OD-17) | `is_active` (tenant) |
| `price`, `currency` | Recognised so they are never mistaken for another field; **never written** (§6) | Notice only | Notice only | none in V1 |

Cell rules common to every field:

- **Text, not numbers, for identifiers.** CSV cells are read as raw text, never type-inferred. An XLSX identifier cell
  stored as a number (which loses leading zeros and turns long barcodes into `6.22E+12`) is a row **error**
  `identifier_numeric_cell` with the fix "format the column as Text" (310). An identifier from a formula cell is an error.
- **No normalisation of identifiers** (310, 313): no case folding, no digit-script conversion. A `barcode` or `plu` that
  contains Arabic-Indic digits (`٠`–`٩`) is an error `identifier_non_ascii_digits`, because no scanner produces them
  and the value could never match a scan (OD-15).
- **Whitespace**: leading/trailing whitespace is trimmed from every cell before validation and the trim is counted as a
  notice (OD-10). "Whitespace" here is Unicode `White_Space` (including U+00A0 NBSP) plus the bidi marks U+200E, U+200F
  and U+061C, which Arabic Excel files often carry. A bidi mark or NBSP left **inside** an identifier is an error
  `identifier_invisible_char` (it passes the contract pattern but can never match a scan). After the trim, identifier
  and name rules apply unchanged.
- **Blank cell**: on Create, blank = absent (the field's default). On Update, blank = **leave unchanged**. V1 has no
  "clear this field" token (OD-5).
- **Formulas** in non-identifier cells: the cached value is used and counted as a notice; a formula with no cached value
  is an error.
- **Duplicates inside the file**: two rows that carry the same `sku`, `barcode` or `plu` are both errors
  `duplicate_in_file` (no first-wins).

## 6. Prices until Pricing exists

The import never writes a price, a currency, a store override price or `price_history` (O-2, PD-2, PD-7). Until
RT-1484 and RT-1485 are Done:

1. A mapped `price` / `currency` column is accepted and labelled in the mapping step "Prices are not imported yet".
2. Each row with a price value gets a non-blocking notice `price_not_imported`.
3. The preview states the consequence: "N new products will be created **without a price**. They will not appear on any
   till until priced in Pricing" (F-4). Updated products keep their current price.
4. The batch keeps the raw price cell text in its staged row (provenance only, never interpreted, never shown as a
   price).

No currency, rounding, tax-inclusive or "price > 0" rule is defined here: those are Pricing semantics (spec 041 /
042, PD-3). Slice S9 (§12) is a separate Planning amendment after RT-1484: at publish, rows with a price may produce
one **draft** Price Change Set that then follows its own validate / approve / publish lifecycle; the import itself
still never publishes a price.

## 7. Matching, modes and the review queue

### 7.1 Matching (decision 420; 311, 313)

Per row, in order, against **active, tenant-wide** identifiers of the tenant, by **(type, value)**, byte for byte. A
`barcode` `123` never matches a `plu` `123`:

1. **Stable source key**: `sku` (OD-1).
2. **Trusted exact identifiers**: every `barcode` and `plu` on the row.
3. **Nothing else.** Name is never a match key; there is no fuzzy or prefix match.

**Store-scoped identifiers** (a store's own `barcode` / `plu`, F-5) are never match keys, because the import is
tenant-level. If a row's value equals an active store-scoped identifier of the same type on **another** product, the
row goes to review `store_scoped_conflict`: adding the tenant-wide value would make scans at that store resolve two
ways (311). Equal to a store-scoped identifier of the **same** product: a warning, no review.

Outcome per row:

| Identifiers found | Result |
|---|---|
| None of the row's identifiers is active (tenant-wide) | `no_match` |
| All found identifiers resolve to one product | `match(product)` |
| Found identifiers resolve to two or more products | `ambiguous` → review (421) |
| The single product is retired | error `product_retired` (no un-retire through import) |
| The row has no identifier at all | `no_match`, plus review `no_identifier` on Create / Upsert (a product with no identifier cannot be scanned and cannot be re-matched by a later import) |

A row that matches a product and also carries a **barcode or PLU** that is free is an **identifier add** on that
product. A row whose identifier is active on a **different** product than the one its other identifiers match is
`ambiguous`, never a move (317).

**SKU mismatch.** A row that matches product P through a barcode or PLU, carries a `sku`, and P already has a
**different** active SKU, goes to review `sku_mismatch`; it never silently adds a second SKU, which would break the
stable-key rule (OD-1). If P has no SKU, the row's SKU is an identifier add, shown in the preview.

### 7.2 Modes (decision 418)

| Mode | `no_match` | `match` |
|---|---|---|
| **Create** | create | error `already_exists` (names the matched product, OD-11) |
| **Update** | error `not_found` | update mapped fields; add new identifiers |
| **Upsert** | create | update |

A matched row whose mapped values equal the current values is `unchanged`: counted and listed, written nowhere.

### 7.3 Row statuses (no silent skip, decision 419)

Every row ends in exactly one status, and the batch counts each:

`ready_create` · `ready_update` · `unchanged` · `needs_review` · `error` · `excluded`

- `error` rows are fixed in the source file and re-uploaded (a new batch version, §8.1). V1 has no inline cell editing
  in the Console, so the file stays the provenance (OD-5 note).
- `needs_review` reasons: `ambiguous`, `no_identifier`, `sku_mismatch`, `store_scoped_conflict`, `possible_duplicate`
  (a Create row whose exact `name` equals an
  active product's name and that has no identifier match). Name equality is a **hint for a human**, never a match.
- Review resolutions, one per row, each recorded with actor and time: **create new**, **update product P** (only a
  product among the row's identifier candidates, or, for `possible_duplicate`, the named product), or **exclude row**.
  For `sku_mismatch`, "update P" keeps P's SKU and does not add the row's SKU. For `store_scoped_conflict`, "create
  new" and "update P" are offered only without the conflicting identifier, which is then listed as not added.
  "Create new" is not offered when an identifier on the row is active on another product.
- `excluded` exists only as an explicit, audited decision. **Publish is refused while any row is `needs_review` or
  `error`.** The merchant either fixes the file or excludes those rows explicitly.
- A decision sets the row's status (contract action names): `create_new` → `ready_create`, `update_product` →
  `ready_update`, `exclude` → `excluded`, and `clear` (undo) → back to the status validation gave it (`needs_review` or
  `error`). An `error` row takes only `exclude` and `clear`.

## 8. Flow, lifecycle, idempotency, limits

### 8.1 Batch lifecycle

The states are the spec 042 §3 names, so the batch can become a `catalog`-domain change set without renaming (§9):

```
           map / re-map / re-upload (version+1)
          ┌──────────────┐
          ▼              │
 upload ► draft ──validate──► validated ──publish (publishable only)──► published
          ▲  │                 │   │
          │  └─cancel/expire─► cancelled | expired      (expired is an import-only terminal state)
          └── mapping change, stale re-check ──┘   └── review decision (stays validated, version+1, new previewHash)
```

- `draft`: uploaded and being mapped. `validated`: rows have outcomes and a `previewHash`. **`publishable`** is a
  derived flag of a `validated` batch: every row is `ready_create`, `ready_update`, `unchanged` or `excluded`.
  `pending_approval` / `approved` are reserved for the OD-12 approval hook and unused in V1.
- A review decision changes one row's resolution, keeps the batch `validated`, increments `version` and recomputes the
  `previewHash`. Re-validation (after a mapping change or a stale re-check) keeps a resolution only while the row's
  candidate set and reason are unchanged; otherwise the row returns to `needs_review`.
- A **re-upload** (the fixed source file) keeps the mode, drops review decisions and sets the mapping to none: the
  previous mapping's entries whose header text is unchanged (exact text; an empty or repeated header is never carried)
  become the **suggested** mapping and take priority ("come first"): the suggestion for the remaining columns leaves
  out every field a carried entry already holds, except `barcode` (at most 5 in total), and the merchant confirms the mapping again before validation. Validation needs a
  confirmed mapping and re-applies the mapping completeness rules (defence in depth), so no column is silently carried
  or skipped (419).
- The review row list is keyset-paginated by row number, and its cursor is bound to the **validation generation** (a
  new one only when validation runs) and the `status` query filter, not to `version`, so recording a review decision
  does not invalidate the paging, and a cursor is never reused under another filter (contract 1.0.2-draft).
- One **open** batch per tenant at a time (a second upload while one is open is `409 import_batch_open`, with the open
  batch's id), which keeps the preview honest and the publish lock simple. Cancel is explicit: like expiry and
  publish it closes the batch (`closed_at` set, `expires_at` cleared), and a cancelled batch keeps no
  `preview_hash` (`preview_hash = NULL`; the counts of its last validation stay).
- Every call that changes the batch sends `expectedVersion`; a mismatch is `409 version_conflict` (spec 042 code).
- An open batch expires after 7 days (`expired`), keeping its rows for audit (30 days, OD-6). `expires_at` is the
  last change + 7 days, moved on every change. The expiry is a conditional
  `UPDATE … SET state = 'expired', … WHERE state IN ('draft','validated') AND version = $v AND expires_at <= now()`
  with the version the worker read, so a batch changed after that read is never expired; expiring closes the batch
  (`closed_at` set, `expires_at` cleared, `preview_hash = NULL` for a `validated` batch, as the contract returns a
  preview hash only when validated or published) and bumps `version`.

### 8.2 Validation is bound to catalogue state (402, 403)

Validation stores, per matched row, the product's `updatedAt`, and a `previewHash` over the ordered row outcomes,
field diffs, identifier adds and mode. Publish requires the `previewHash` the merchant saw. Under the per-tenant import
publish lock, publish re-checks: every matched product's `updatedAt` unchanged, every identifier to add still free,
every referenced category and brand still active, every brand to create (OD-3) still absent. Any difference →
`409 stale_validation`, the batch returns to `draft`, and the merchant re-validates and sees a new preview (the spec
042 §3 pattern, simplified: any intersection is stale).

The single-product console writes do not take the import publish lock, so the re-check alone leaves a gap between check
and write. The publish therefore also writes **conditionally inside its transaction**: each product update passes
`expectedUpdatedAt = matched_updated_at` to the shared domain function, and each identifier add and brand create relies
on the existing unique indexes. A `stale_write`, a unique violation (`alias_conflict`, `brand_name_conflict`) or a
vanished reference inside the transaction rolls the whole publish back and is answered `409 stale_validation`, never
a 500.

### 8.3 Atomic publish (405, 450)

One database transaction for the whole batch: every brand create (OD-3 B), every product create / update, every
identifier add, every audit row and the batch's own `published` transition. Any failure rolls back everything; nothing is half-published. The existing
`catalog_change_log` triggers then carry the changes to the POS delta with no other step (F-10). The publish writes go
through the same domain functions as the console writes (same checks, same audit actions), so the import cannot
diverge from the single-product rules.

### 8.4 Idempotency

- **Upload**: `Idempotency-Key`, but **not** through the existing interceptor as is: it fingerprints
  `canonicalJson(req.body)`, and a raw-body route has no parsed body (F-9), so every file sent under one key would share
  one fingerprint and a different file would replay the first batch. S1 / S4 define upload idempotency as key **plus the
  file's SHA-256 plus the canonical query** (`mode`, `sheet`, `delimiter`, `file_name`) as the fingerprint, so the same
  key with the same bytes and query replays the batch and the same key with other bytes or any other query value is
  `409 idempotency_key_conflict`. The canonical query is the decoded parameter values compared byte for byte, with no
  Unicode normalisation (an Arabic file name can arrive in NFC or NFD form); an absent parameter is distinct from any
  value, so an explicit `sheet` naming the default first sheet differs from no `sheet` (contract 1.0.2-draft).
  The file's SHA-256 is also stored; uploading a file whose hash equals a batch published in the last 30 days is a warning that names that batch,
  not a refusal.
- **Publish**: `Idempotency-Key` plus the batch state. A publish of an already `published` batch with the same
  `previewHash` returns the stored result (`200`, replay); with a different `previewHash` it is `409`. A network failure
  on publish is resolved by resending the same key, never by a new upload (the Console never says "published" until the
  server confirms).
- **Review decisions and mapping**: idempotent by `expectedVersion`.

### 8.5 Limits (OD-7)

| Limit | V1 value | Reason |
|---|---|---|
| File size | 5 MiB | Covers 5,000 rows × 20 columns with Arabic text; above the 100 kB default, so it uses a route-scoped raw-body limit with header pre-authentication and a concurrency bound (RT-1284 / RT-1295 rule, F-9) |
| Rows per batch | 5,000 data rows | One transaction, synchronous validate and publish |
| Columns | 50 | Mapping UI and parse cost |
| Cell length | 2,000 chars (description); other fields per §5 | Field contract |
| XLSX | `.xlsx` only (`.xlsm`, `.xls`, `.xlsb` refused); uncompressed size ≤ 50 MiB; ≤ 200 zip entries; one sheet read | Zip-bomb and macro guard. Type from content, never from the `Content-Type` header or the file name (spec 039 FR-03): a ZIP signature (`PK\x03\x04`) whose `[Content_Types].xml` declares the `spreadsheetml.sheet.main+xml` workbook type is XLSX; a macro-enabled or binary workbook type, or any `vbaProject.bin` entry, is refused `file_type_unsupported`; an OLE2 signature (`.xls`) is refused. Any other bytes are tried as CSV and must decode as UTF-8 text with no NUL byte |
| CSV | UTF-8 with or without BOM; delimiter `,` `;` or tab, detected and shown for confirmation; RFC 4180 quoting | Invalid UTF-8 is `encoding_not_utf8` with the fix "save as CSV UTF-8" (OD-8) |
| Latency budget | validate p95 ≤ 10 s and publish p95 ≤ 15 s at 5,000 rows | Measured in S8; if missed, move validate / publish to a worker job (OD-7) |

### 8.6 Authority and security

- Roles: `owner`, `tenant_admin` only (Product identity, 449). `store_manager` and `store_staff` get the non-disclosing
  404, as on the catalogue writes. A platform admin with an organization open acts as on the other tenant writes
  (RT-1468).
- Tenant from the session only; every new table under FORCE RLS; cookie-session writes keep the `Origin` check.
- The original file bytes are **not stored**: the batch keeps file name, size, SHA-256, parser and mapping version, and
  the parsed cell text of each row (OD-6). Staged rows are tenant data and never leave the tenant (no Global Index
  contribution, §11).
- Error report and preview never show another tenant's data; within the tenant, matched products are named (OD-11).

### 8.7 Audit and provenance (decision 423)

- Batch events: `catalog.import.upload`, `.map`, `.validate`, `.review` (per decision), `.publish`, `.cancel`,
  `.expire`, each with batch id, version, counts and file hash.
- Per product change at publish: the existing `catalog.product.create` / `catalog.product.update` and identifier-add
  audit actions, each carrying `import_batch_id` and the source row number (OD-13).
- Provenance query: each published staged row keeps its `product_id`, so "which batch and row created or last changed
  this product" is answerable without a new column on `tenant_products`.
- Retention: staged rows of a published batch are kept 13 months, then reduced to the batch summary; rows of a
  cancelled or expired batch are kept 30 days (OD-6).

## 9. Change Set: interim now, primitive later

Decision 400 and O-5 want catalogue changes to publish through the one shared Catalog + Pricing revision engine. It does
not exist (F-8). The issue's scope says: reuse it if it exists by build time, otherwise define the interim.

The check happens **once, when S1 (contract) and S2 (tables) reach Definition of Ready**, because that is where the
choice lands; S4 and S5 follow whatever S1 / S2 chose.

- **If RT-1484 has merged the shared `change_sets` primitive by then**: an import batch is a `catalog`-domain
  change set (header row in `change_sets`; the staged rows are its items). The §8.1 states already are spec 042 §3 names
  (`draft`, `validated`, `published`, `cancelled`; `expired` would be an import-domain addition to the primitive);
  approval uses the primitive's hook (OD-12); publish allocates a catalogue revision (407). This needs a Planning check of the primitive as built.
- **Otherwise (interim)**: the import keeps its own batch tables (§10) with spec 042's state names, `version` /
  `expectedVersion` (`409 version_conflict`), `previewHash` and publish lock, so a later slice can move the batch header into `change_sets` without changing the
  Console flow or the contract's observable states. The interim publish is an audited direct write, the same posture
  O-1 approved for the single-product console writes. No catalogue revision number is promised in the interim (407 is
  not yet met by any catalogue write on `main`).

### 9.1 Re-check outcome (S2 Definition of Ready, 2026-11-19): interim tables

The re-check was made at RT-1503's Definition of Ready (RT-1503 comment 17830, W1 catalogue lead). Outcome: **stay on
the interim import tables (OD-14 A)**. A `change_sets` table is on `main` (migration `0121_pricing_core.sql`, with
items and lines in `0123_price_change_set_items_lines.sql`, RT-1151), but it is the pricing primitive, not a
domain-neutral one:

- `CONSTRAINT change_sets_domain CHECK (domain IN ('pricing'))`: a `catalog` domain would need a pricing schema change.
- No-delete triggers (`change_sets_no_delete_row`, `change_sets_no_delete_truncate`): they conflict with the OD-6
  retention purge of staged rows and of cancelled or expired batches.
- No `expired` state in `change_sets_state` (§8.1 needs it as the import-only terminal state).
- The 0123 content rules are commit-time constraint triggers that expect pricing rows (a
  `price_change_set_validations` row for a validated set); an import batch has none.
- Its runtime (RT-1484) is not built yet, so there is no primitive behaviour to reuse.

Adopting it would therefore mean changing the pricing schema inside an import slice. The import keeps spec 042's state
names (§8.1), `version` / `expectedVersion`, `previewHash` and the publish lock, so the later move into a
domain-neutral `change_sets` stays a header move. S4 and S5 follow this choice.

## 10. Conceptual data model (for the S2 migration; not DDL)

Interim tables (§9.1), created by migration `0124_catalog_import` (RT-1503). Every table carries `tenant_id`, is under
ENABLE + FORCE RLS with tenant policies for select, insert and update, and references its parent through a composite
`(tenant_id, id)` foreign key. **Only `catalog_import_rows` has a delete policy** (and the domain role's `DELETE`
grant): a re-upload replaces the old file's rows and the retention purge removes them. The batches have no delete
policy and a trigger refuses `DELETE` and `TRUNCATE` for every role (the header is the lasting summary); the mapping
profiles have no delete policy. Column names are the S2 migration's; the wire names are the contract's
(`catalog/catalog-import.yaml`).

- `catalog_import_batches`:
  - identity and lifecycle: `id`, `tenant_id`, `state` (§8.1 names, including the reserved `pending_approval` and
    `approved`), `version` (bumped by every batch change, the `expectedVersion` precondition), `mode`;
  - **`validation_generation`** (integer, starts at 0, bumped **only** by validate): the row-list cursor is bound to
    it (§8.1). It must never fall back to `version`, which a review decision bumps and which would bring back the
    paging bug fixed in contract 1.0.1-draft;
  - file facts: `file_name`, `file_size`, `file_sha256`, `file_kind` (`csv` | `xlsx`), `sheet_name`, **`csv_delimiter`**
    (`null` for XLSX), **`data_row_count`**, **`column_count`**, `parser_version`;
  - **`columns`** (the header text and up to three sample values per column, as the contract's `columns` returns them;
    the bytes are not stored, so the samples cannot be recomputed);
  - `mapping`: the contract's `ColumnMapping[]` (column number → target, a canonical field or `ignore`), `null` until
    confirmed and again after a re-upload,
    **`suggested_mapping`** (**stored**, not recomputed on read: it depends on the previous mapping at re-upload time and
    on the profiles as they were then, so a read must return what the merchant was shown), also a `ColumnMapping[]`;
    `mapping_profile_id`, a composite `(tenant_id, mapping_profile_id)` foreign key to the profiles;
  - **`warnings`** (**stored**, the contract's `BatchWarning[]`): computed at upload and at re-upload, never naming the
    batch itself (a trigger refuses that), and returned as stored;
  - `preview_hash`, `counts`;
  - **`publish_summary`** (**stored** at publish, `null` before): a publish replay returns it, and the replay must
    outlive the idempotency-key TTL (§8.4);
  - `created_by`, `created_at`, `updated_at`, `published_at`, `expires_at` (open `draft` / `validated` only);
  - **`closed_at`**: set when the batch is published, cancelled or expired; closing also clears `expires_at`. A closed
    batch is frozen except for `rows_purged_at`;
  - **`rows_purged_at`**: set once, by the retention purge, when it deletes the batch's rows.
- `catalog_import_rows`: `batch_id`, `tenant_id`, `row_number`, `cells` (parsed text per source column), `status`,
  `outcome` (match result, candidate product ids, field diff, identifier adds), `issues` (`code`, `field`, `severity`
  error | review | warning | notice), **`review_reason`** (one of the §7.3 reasons, `null` unless validation sent the
  row to review; kept when a decision changes the status, so `clear` and re-validation can compare it), `resolution`
  (+ actor, time), `matched_updated_at`, `product_id` (after publish). `row_number` is the **source** row number
  (row 1 is the header; 2..1,048,576, the XLSX sheet maximum): a skipped blank row leaves a gap, so it is not bounded
  by the 5,000-row limit, which applies to `data_row_count` only. Primary key `(tenant_id, batch_id, row_number)`,
  which is also the keyset order of the review list; the rows reference their batch by `(tenant_id, batch_id)`.
- `catalog_import_mapping_profiles`: `id`, `tenant_id`, `name` (1–100 characters, unique per tenant: saving under an
  existing name is an upsert that replaces the entries and **keeps the `id`**, so a batch's `mapping_profile_id` stays
  valid; contract `saveProfileName`), `entries` (header text → canonical field or `ignore`, keyed by the exact trimmed
  header text, as the re-upload carry is; an **empty or repeated header is never saved** in a profile, since it cannot
  identify its column), `created_by`, `created_at`, `updated_by`, `updated_at`. No delete policy.
- Indexes the rules need:
  - **one open batch per tenant**: a partial unique index on `catalog_import_batches (tenant_id)` where `state` is one of
    `draft`, `validated`, `pending_approval`, `approved` (the reserved approval states count as open, so OD-12 can be
    added without a schema change); the upload's `409 import_batch_open` is this index's refusal;
  - **previous-publish lookup**: an index on `(tenant_id, file_sha256, published_at)` for the 30-day
    `file_previously_published` warning (§8.4);
  - **expiry sweep**: a partial index on `(expires_at)` where `state` is `draft` or `validated` (§8.1).
- Retention and expiry (OD-6, §8.1, §8.7). **S2 (RT-1503) owns the worker job**; no other slice does:
  - an open `draft` or `validated` batch not changed for 7 days becomes `expired`, measured from its last change
    (`expires_at = updated_at + 7 days`, moved on every change), through the conditional `UPDATE` of §8.1, with one
    `catalog.import.expire` audit row per batch;
  - rows of a `cancelled` or `expired` batch are deleted 30 days after that transition (`closed_at`), and the batch's
    `rows_purged_at` is set;
  - rows of a `published` batch are deleted 13 months after `published_at`; the batch header with its `counts` and
    `publish_summary` stays as the summary.
  - File bytes are never stored, so there is nothing else to purge.
- Runtime grants in `grant-registry.ts` plus a `docs/operations/sql/*-domain-grants.sql` deploy step (gated-changes rule).

## 11. Admin Console flow (outline; control surface only, 445)

Products → **«استيراد المنتجات»** (owner / tenant_admin only), a dedicated workspace, not a drawer (UX-05.27). The
step layout, per-row result report, dry-run validation and preview are **Advisory** (ux-pos-console G1 / G2): the
house rules do not define bulk import UX, so S7 needs an owner review of the screens.

| Step | Purpose and primary action | States and truth rules |
|---|---|---|
| 1 Upload | Choose mode (Create / Update / Upsert, explained in one line each), download the template (Arabic and English headers), pick the file. Primary: «رفع الملف» | Client size / type checks are hints only; Backend-Core decides (spec 039 FR-20). An open batch → resume or cancel it |
| 2 Map | Auto-mapped columns from header synonyms and the saved profile; required fields marked; every unmapped column listed as «سيتم تجاهله» until confirmed. Primary: «تحقق» | Price column labelled "not imported yet" (§6) |
| 3 Validate | Counts per status (§7.3) as a status band, then a semantic table of rows filtered by status, the row number first, issues in words with the field named. Download «تقرير الأخطاء» (CSV) | Count only what the server returned; keep rows on a failed continuation (UX-10.17–.18) |
| 4 Review | One row at a time or a filtered list of `needs_review`; candidates shown with name and identifiers; resolutions: create new / update this product / exclude row (as §7.3 allows per reason) | Exclusion is explicit and shown in the final counts |
| 5 Preview | Impact: brands to create (OD-3), products to create, products to update (field-level before → after), identifiers to add, rows excluded, unchanged, "N products will be taken off the tills (`is_active` → false)" (OD-17), and "N new products without a price will not reach the tills" (403) | A `409 stale_validation` resets to Validate with a notice that the catalogue changed (UX-10.19) |
| 6 Publish | `ConfirmModal` naming the action, the counts and the consequence, focus on «إلغاء» (UX-05.2, .23) | No success wording until the server confirms; an unclear answer (network, 5xx, 425, 429) resends the same `Idempotency-Key` and body (UX-01.19 discipline) |
| 7 Result | Batch summary, link to the products list, the batch's audit reference (copyable, LTR) | Undo is not offered: no domain contract restores a batch (UX-05.21) |

Arabic first, RTL, Arabic copy written in S7 per `rtl-arabic-copy.md`; identifiers and file names isolated LTR. The
Console parses nothing and validates nothing authoritatively; it renders server outcomes.

**Methods 1 and 2 and 83329059.** The Create path reuses the same domain function as the single-product create, so
method 1 and method 3 cannot diverge. The staging → exact match → review → approve core (83329059 §3) is the piece a
future W2 manual-supplier-invoice flow (method 2) can reuse for "suggest an item to match or create as a draft"; that
reuse needs its own W2 Planning item and grants no purchasing write here.

### 11.1 83329059 §8 open points that touch import

| §8 point | Answer for import |
|---|---|
| Central contribution consent (tenant-level or per source / batch) | **Not touched in V1**: an import never nominates anything to the Global Product Index; staged rows stay tenant data. If contribution is ever enabled, the safe proposal (opt-in per source, revocable) would apply per import batch. Left to the owner |
| Publishable fields per sector, source reliability tiers, editor duties | Not touched: no central path from import |
| Correction / objection / withdrawal policy for the central reference | Not touched |
| Arabic PDF / image success criterion; when manual entry stays the only path | Not touched (method 4 excluded). CSV / XLSX and manual entry stay available regardless (83329059 §2 "permanent path") |
| Which supplier interfaces are allowed | Not touched (method 5 excluded) |

## 12. Implementation slices (each needs its own Definition of Ready)

Contract-first order. Each slice is one bounded issue; the gated kinds are named for the PR title. After the owner
accepted OD-1..OD-17 ("Do all recommended", 2026-11-19), S1–S9 were created as RT issues: **S1 = RT-1502, S2 = RT-1503,
S3 = RT-1504, S4 = RT-1505, S5 = RT-1507, S6 = RT-1506, S7 = RT-1509, S8 = RT-1510, S9 = RT-1508**. S10 is **not
created**: OD-3 chose A for categories (RT-1489 comment 17790).

| # | Slice | Work Mode | Surface | Gated | Depends on |
|---|---|---|---|---|---|
| S1 (RT-1502) | **Import contract**: new `packages/contracts/openapi/catalog/catalog-import.yaml` — upload (raw body; key + file-hash idempotency, §8.4), get batch, set mapping, validate, list rows (keyset), review decision, preview, publish, cancel, template download, error-report download; error codes of §5–§8; rate-limit classes | Implementation (contract) | `services/backend-core/packages/contracts/` | `[GATED: contract]` | Owner decisions on this record; §9 primitive check |
| S2 (RT-1503) | **Import schema**: the §10 tables, FORCE RLS, grants, domain-grants SQL, retention job hook | Implementation | `packages/db/drizzle/`, `apps/api/src/auth/grant-registry.ts` | `[GATED: migration]` | S1; §9 primitive check |
| S3 (RT-1504) | **Parser dependencies**: CSV and XLSX parsers in Backend-Core (OD-9), with `dependency-review` clean | Implementation | `services/backend-core/package.json`, `pnpm-lock.yaml` | `[GATED: deps/lockfile]` | OD-9 |
| S4 (RT-1505) | **Upload, parse, map, validate** runtime: raw-body route with pre-auth and concurrency bound, magic bytes, XLSX bomb guards, mapping profiles, row validation, matching (§7.1), statuses | Implementation | `apps/api/src/catalog/catalog-import/`, raw-body route on the `tenant-branding/logo-body.ts` pattern, `apps/api/src/common/json-body-limits.ts` (route-scoped limit note) | none beyond S1–S3 | S1, S2, S3 |
| S5 (RT-1507) | **Review, preview, publish** runtime: review decisions, `previewHash`, publish lock, stale re-check, conditional writes (§8.2), brand creates (OD-3), one-transaction publish through the console-catalog domain functions, audit, idempotency | Implementation | `apps/api/src/catalog/catalog-import/`, `console-catalog.write.service.ts` (extract shared functions, no wire change) | none beyond S1–S2 | S4 |
| S6 (RT-1506) | **Console client repin** to the S1 contract on `main` | Implementation | `apps/admin-console/` generated client and PIN | `[GATED: contract]` pin follow-up | S1 merged |
| S7 (RT-1509) | **Console import workspace** (§11), Arabic / English copy, Playwright + axe, keyboard walk, forced colours; owner screen review first (Advisory G1 / G2) | Implementation | `apps/admin-console/src/catalog-import/`, reusing the raw-body upload of `src/branding/LogoUploadField.tsx` / `tenant-branding-queries.ts` (extract, not copy) | none | S5 (runtime), S6 |
| S8 (RT-1510) | **Verification**: 5,000-row Arabic XLSX and CSV, leading-zero and numeric-cell barcodes, `.xlsm` / bomb refusal, RLS isolation between two tenants, publish atomicity under injected failure, stale validation, idempotent replay, POS delta picks up published products and omits unpriced ones, latency budget | Verification | lab or CircleCI `api` / `admin-e2e` | none | S5, S7 |
| S9 (RT-1508) | **Prices through Pricing** (Planning amendment, then Implementation): price columns produce one draft Price Change Set per batch | Planning → Implementation | spec 049 amendment; Pricing module | `[GATED: contract]` likely | RT-1484, RT-1485 Done |
| S10 (not created) | **Category create** (only if OD-3 chooses B): a governed category write and its use from import | Planning → Implementation | console-catalog contract | `[GATED: contract]` | OD-3 |

### 12.1 Open items for S4 (RT-1505) and S5 (RT-1507), recorded at S2

Raised in the S2 (RT-1503) review. They do not change the 0124 schema; each must be settled in the named slice's
Definition of Ready, with a contract revision where the wire changes:

- **Upload fingerprint serialisation (S4).** The §8.4 fingerprint (key + file SHA-256 + canonical query) is serialised
  as a JSON array of the canonical query values in a fixed parameter order (`mode`, `sheet`, `delimiter`,
  `file_name`), with `null` for an absent parameter, so an absent parameter can never serialise like any value.
- **Profile selection rule (S4).** When a tenant has several mapping profiles, the rule that picks the one
  `suggestedMapping` draws on (and so `mappingProfileId`) is not yet defined; S4 defines it and its tie-break.
- **Reads after the row purge (S4 / S5).** Once the retention purge has deleted a batch's rows (`rows_purged_at` set),
  the row list, preview and error report have nothing to return. The contract has no refusal for that yet; a later
  contract revision adds one, and the runtime must not answer with an empty list as if the batch had no rows.
- **Blank rows and `row_number` (S4).** A row's number is its source row number (row 1 is the header), so the row
  numbers of a batch can have gaps where the file has fully blank rows. S4 decides whether a blank row is skipped (a
  gap, and not counted in `data_row_count`) or staged as an `error` row, and states it with the no-silent-skip rule
  (decision 419). 0124 (lead decision, RT-1503 review round 3): `row_number` is the source row number, bounded only
  by the XLSX sheet maximum (2..1,048,576), so gaps never push a valid file out of range; the 5,000 limit applies
  to `data_row_count` alone.

### 12.2 Settled and proposed in S4 part A (RT-1505: upload and file guards)

- **Blank rows.** A data row with no value in any cell is skipped: a gap in the source row numbers, not counted in
  `data_row_count`. Every row with a value is kept (a whitespace-only cell is blank; a number, boolean, date or formula
  cell is a value, even a formula with no cached one). The header must carry a value (`header_missing`). A trailing
  empty cell does not widen the file; a data column with no header is kept with an empty header (it must be mapped or
  ignored, decision 419).
- **Physical rows.** A source file with more than 1,048,576 physical rows, CSV as well as XLSX, is `422
  file_too_many_rows` (RT-1503 comment 17873). A CSV record counts once however many lines it spans. For XLSX only, a
  sheet whose valued cells reach so far down and across that the library would build more than 10,000,000 cells is
  `xlsx_limits_exceeded` (the library pads every row to the widest valued cell).
- **Staged cells (PROPOSED, pending owner approval).** `catalog_import_rows.cells` is documented as parsed text. To let
  validate apply the §5 rules to numeric and formula cells once it knows the mapping, the implementation stages plain
  text as a JSON string, a blank cell as `null`, and a typed XLSX cell as an object (`{t: "n"|"b"|"d", v}`; a formula
  `{t: "f", v}` with its cached value or `null`; `apps/api/src/catalog/catalog-import/staged-cell.ts`). No schema
  change (`cells` is `jsonb`), but the shape of an immutable column is a data-model decision the owner has not
  approved; until then it is a proposal and may change before S5 builds on it. Cells are staged untrimmed; the trim
  and its notice count are validate's (OD-10).
- **Upload fingerprint.** `req.body` of the raw upload is the fingerprint object `{fileSha256, query: [mode, sheet,
  delimiter, file_name]}` (absent as `null`), so the shared idempotency interceptor serves the replay and the
  `409 idempotency_key_conflict` unchanged (§12.1 "Upload fingerprint serialisation").
- **Capacity.** At most four uploads in the process and one per tenant hold a slot, from before the body is read until
  the parse and write are done (not only until the response ends); a body not received within 30 s is dropped (400).
  One more is the contract's `429 rate_limited` with `Retry-After`, answered before its body is read (the contract has
  no 503). `read-excel-file` parses on the calling thread, so a read blocks the event loop for its duration; worker-thread
  isolation is a recorded follow-up.
- **The library never sees the upload.** After the zip guard, `read-excel-file` reads a stored-only archive rebuilt from
  the verified parts (a synthesized one-sheet workbook and relationships, the chosen sheet, shared strings and styles),
  because it re-parses a ZIP with rules of its own (local headers, fixed part paths, a SAX parser). The sheet itself
  is re-serialized from the pre-scan's own tokens (rows, cells with `r`/`t`/`s`, `<v>`, inline strings), so the library
  reads exactly what the scan understood; anything two XML readers could read differently (a duplicate or unspaced
  attribute, a `<!` declaration, a non-canonical entity, a tag over 8 KiB) is `file_unreadable`.
- **No uploaded XML reaches the library byte for byte** (security review of PR #761, rounds 1 to 3). The workbook, the
  relationships and the content types are synthesized; the sheet, the styles and the shared strings are re-serialized
  from the strict tokenizer's own tokens (`xlsx-sheet-scan.ts`, `xlsx-parts-scan.ts`), keeping only what the library
  reads, with caps: 64,000 `<xf>` per list, 1,000 `<numFmt>` and 64 KiB of format-code text in all (a format code at most
  255 characters), 250,000 shared
  strings of at most 32,767 characters, 64 attributes and 8 KiB per tag. The library's own date-format check is
  quadratic in the format code and it builds an object per `<xf/>`, so they are bounded before it runs.
- **Staged text cap (lead decision 2026-11-20, pending owner acknowledgement).** At most 8,000,000 characters of cell
  text per batch in total (header and data), refused as `xlsx_limits_exceeded`. It applies to XLSX in practice: a CSV is
  bounded by its 5 MiB size, and the cap is applied to both uniformly. It is enforced as the sheet is scanned (a shared string counts once per cell that
  points at it, before the library runs) and again as rows are built. A shared string used by every cell of 5,000 rows
  of 50 columns would otherwise stage about 500 million characters from a 500 KB upload. Staged rows are inserted 500
  to a statement in the same transaction.
- **For part B: booleans.** LibreOffice writes a boolean as a formula (`=TRUE()`), so it stages as `{t: "f", v: {t: "b",
  v: "true"}}`; the `is_active` rule must read the cached value of a formula cell, and the "formula in a non-identifier
  cell" notice (§5) applies to it.
- **Settled in part B (see 12.3).** The profile selection rule, the suggestion and the read refusal after the
  retention purge, which were open here.

### 12.3 Settled and proposed in S4 part B (RT-1505: map, validate and the row list)

Settled by the implementation; where a rule goes beyond spec 049 sections 5 to 8 it is marked and awaits the lead's or
the owner's acknowledgement. Contract 1.0.4-draft states each in its description text; no schema shape changes.

- **Served.** `consoleSetCatalogImportMapping`, `consoleValidateCatalogImport` and `consoleListCatalogImportRows`
  (the contract's own marker says the list is part of S4). Audit rows `catalog.import.map` and `catalog.import.validate`
  carry ids and counts only (the notice, warning and error counts per issue code; never a header, a cell, a file or
  profile name).
- **Profile selection rule and tie-break** (the open item of 12.1). A new batch stores a suggestion: for each column the
  profile entry of its exact trimmed header (a header that is empty or appears twice never takes one) comes first, then the
  header synonyms (English and Arabic; the match ignores case, spacing, punctuation, Arabic diacritics and the alef, ya and ta
  marbuta variants). The profile is the one covering the most usable headers (at least one); a tie goes to the most
  recently updated, then the smaller name, then the smaller id (UTF-16 code units). The 200 most recently updated profiles
  are considered. A field is suggested once (`barcode` up to five columns); `ignore` only comes from a profile.
  `mappingProfileId` names the profile only when it placed a column. A saved profile keeps the exact trimmed header text
  of each column whose header is not empty and appears once; a `saveProfileName` with no such column is `422
  mapping_invalid` (it is never dropped silently).
- **Mapping and validate order.** Both lock the batch row, then: 404, closed (`409 import_batch_closed`),
  `409 version_conflict`, then the 422 rules. Set mapping and validate both bump `version` and move the expiry;
  validate also bumps the validation generation, stores the counts and the `previewHash`, and clears review decisions
  (none can exist before S5, which refines this to keep a decision whose candidate set and reason are unchanged).
- **Trim.** Every cell is trimmed, mapped or not, and each cell the trim changes is one `whitespace_trimmed` notice on its
  row (the batch has no count field: the per-issue totals are in the audit row). The row list shows the cells after the
  trim.
- **Identifier cells.** A number cell is `identifier_numeric_cell`; a formula cell is `identifier_formula_cell`, cached or
  not; a boolean or date cell is `value_invalid`. Inside an identifier a NBSP or a bidi mark is
  `identifier_invisible_char`; Arabic-Indic and Persian digits in a barcode or PLU are `identifier_non_ascii_digits`; the
  console write's own identifier pattern applies (no control character, no outer whitespace, 200 characters). A digits-only
  barcode of 8, 12, 13 or 14 characters with a wrong GS1 check digit is the warning `gtin_check_digit`.
- **Formulas elsewhere.** A mapped field other than an identifier reads the cached value and counts the notice
  `formula_cached_value`; no cached value is `formula_without_value`. LibreOffice's `=TRUE()` booleans therefore read for
  `is_active`. `price`, `currency` and ignored columns are never interpreted, so a formula there is not an error.
- **Matching.** The products the row's active tenant-wide identifiers resolve to are united: none is `no_match`, one is
  `match`, two or more `ambiguous` (a review in every mode). A retired matched product is `product_retired` in every
  mode. A store-scoped identifier counts whatever the state of its store (a deleted store's leftover too, since the stores
  module cannot be asked from the catalogue without an import cycle: a review is the safe answer) and is checked only
  for a value the row would add.
- **Statuses and reasons.** A row with any error is `error`, drops its review issues and writes nothing (no field change,
  identifier add or brand to create). Otherwise the review reason is the first that applies of `ambiguous`,
  `sku_mismatch`, `store_scoped_conflict`, `no_identifier`, `possible_duplicate`; the others are still listed as issues.
  `possible_duplicate` is checked against non-retired products and lists at most five. `required_field_missing` applies
  only when the row would create. `deactivates_product` is a warning only when an active product goes inactive.
- **`previewHash`.** `sha256:` over the canonical JSON of the mode and, per row in order, the status, review reason,
  matched product and its `updated_at` (microseconds kept), candidates, field changes, identifier adds, brand to create
  and a review-decision slot that is `null` until S5.
- **Row list.** Keyset by row number; the cursor is unsigned and bound to the tenant, the batch, the validation
  generation and the `status` query parameter. A `draft`, `cancelled` or `expired` batch, and a batch whose rows were
  purged (`rows_purged_at`), is `409 import_batch_not_validated` (the interim answer to the open item of 12.1: never an
  empty page).

## 13. Acceptance criteria for this Planning item (RT-1489)

- [x] Field contract, identifiers and collisions (§5, §7.1), modes (§7.2), validation and review queue (§7.3), preview,
  impact and atomic publish (§8.2–§8.3), Change Set interim (§9), idempotency, audit and limits (§8.4–§8.7), prices
  (§6), contract-first slices per surface (§12), with options and recommendations (decision-record.md).
- [x] Slices named; created as RT issues only after the owner accepted OD-1..OD-17 (S1–S9 = RT-1502, RT-1503,
  RT-1504, RT-1505, RT-1507, RT-1506, RT-1509, RT-1510, RT-1508; S10 not created, §12).
- [x] 83329059 §8 points that touch import answered or listed for the owner (§11.1).
- [x] Reviewed and merged as docs (PR #711).
- [x] Linked Confluence draft: RETAIL page 86343681 (unpublished draft under the Catalog page 23461894; the owner
  publishes it on approval).
