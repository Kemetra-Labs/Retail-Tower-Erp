# Spec 049 — Manual-first product import (CSV / XLSX): upload, map, validate, preview, publish

| | |
|---|---|
| **Jira** | RT-1489 (W1, Epic RT-1). Planning, horizon Post-Pilot (owner decision 4, RT-1478 comment 17637: plan now, build post-pilot) |
| **Work Mode** | Planning. This folder is the deliverable. No OpenAPI, migration, runtime, package, lockfile or CI file is changed |
| **Primary repository** | `Kemetra-Labs/Retail-Tower-Erp`, `services/backend-core/` (the authority). Consumer: `apps/admin-console/` |
| **Baseline** | `origin/main` @ `f30c5de34` (2026-11-19) |
| **Decisions honoured** | Confluence RETAIL 23461894 (Catalog 276–460), especially 416–423 (imports), 301–319 (identifiers), 392–394 (lifecycle), 400–408 (Change Sets), 445–450 (Console, bulk actions). 83329059 (product acquisition, methods 1–3, §4, §7 "Direct/core", §8). 84050068 CR01, CR06, CR16. RT-281 O-1, O-2, O-5 (comment 14125). RT-827 PD-1..PD-9 (comment 15253) |
| **Decision record** | [decision-record.md](decision-record.md): OD-1 to OD-16, each with options and a recommendation. **None is owner-approved yet** |
| **Status** | DRAFT for owner review |

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
| F-6 | **Product fields**: `name` (1–500), `description` (≤ 2000), `category_id`, `brand_id`, `tax_category` (free text 1–50, required), `is_active`, `tracking_mode` / `expiry_required` (own surface, `tracking-profile.yaml`), `default_price` / `default_currency_code` (legacy, not writable), `source_global_product_id`, `correlation_id`. | `packages/db/src/schema/catalog/tenant-products.ts` |
| F-7 | **Categories cannot be created through any API**: only the seed CLI inserts them. They are unique per tenant by name. **Brands can** (`consoleCreateCatalogBrand`), unique among a tenant's active brands by exact name. | `packages/db/src/cli/seed-catalog.ts:216`; `tenant-product-categories.ts`; `console-catalog.yaml` "Brands" |
| F-8 | **No Change Set primitive exists.** Spec 042 §9 defines the shared domain-neutral `change_sets` primitive (`domain` = `pricing`, later `catalog`); O-5 approved one shared Catalog + Pricing publish/revision engine; PM-5 maps to RT-484 (spec 042, Done), whose runtime is RT-1484 (To Do). | `specs/042-price-change-set-lifecycle/plan.md` §9; RT-281 comments 14125, 14154 |
| F-9 | **Upload precedent**: tenant logo (spec 039 OD-14) sends a raw byte body under any `Content-Type`, checks magic bytes, needs no multipart parser; bytes live in Postgres `bytea` (OD-1), no object store exists. Large bodies follow RT-1284 / RT-1295: a route-scoped limit, read only after the route's guards pass on headers alone, with a concurrency bound. | `specs/039-tenant-logo-branding/spec.md` FR-04, OD-1, OD-14; `apps/api/src/common/json-body-limits.ts` |
| F-10 | **Shared machinery to reuse**: the `Idempotency-Key` interceptor (`apps/api/src/idempotency/`, table `idempotency_keys`), `audit_events`, the `catalog_change_log` triggers that feed the POS delta, the console rate-limit classes (`apps/api/test/console-rate-limit/classes/catalog/`), the operator store-scope rule, FORCE RLS tenant context, the per-tenant advisory-lock precedent (`lockPostingFeedSequence`, `tenantLogoLockKey`). | paths named |
| F-11 | **Admin Console** has catalogue list, detail, edit, identifier add / retire and store-override screens under `src/catalog/`, plus `ConfirmModal`, `FailureBanner`, `ImpactList` and `useServerRead` for force-with-preview flows. It has a CSV **download** helper (`src/sales-daily/downloadCsv.ts`) and **no file-upload component**. | `apps/admin-console/src/catalog/*`; ux-pos-console `console.md` |

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
  The upload EXTENDS the spec 039 raw-body pattern. The BUILD is the staging batch (file → rows → mapping → validation
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
- An error report file (CSV) the merchant downloads, fixes and re-uploads.
- Audit and provenance for every batch, every decision and every product change.

### 4.2 Not in V1 (seam kept)

| Excluded | Why / where it goes |
|---|---|
| Writing any price | O-2, PD-2. Price columns are recognised and never written (§6, OD-2). After RT-1484 / RT-1485 a later slice turns them into a **draft** Price Change Set (S9) |
| Store overrides, store availability, store-scoped identifiers | Store authority and store scope (361, 449) add a second permission model to every row; OD-4 |
| Tracking profile, expiry requirement, capabilities, units, packs, variants, families | Tracking changes are impact operations (387); units / packs / variants are not modelled on `main` (F-6) |
| Retiring, un-retiring or deleting products; retiring or moving identifiers | 317, 394; the import never removes anything |
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
| `tax_category` | 1–50 chars, no NUL; a value the tenant has never used is a **warning** (likely typo; free text on `main`) | **Required** | Optional | `tax_category` |
| `is_active` | One of `true`/`false`, `1`/`0`, `yes`/`no`, `نعم`/`لا` | Optional, default `true` | Optional | `is_active` (tenant) |
| `price`, `currency` | Recognised so they are never mistaken for another field; **never written** (§6) | Notice only | Notice only | none in V1 |

Cell rules common to every field:

- **Text, not numbers, for identifiers.** CSV cells are read as raw text, never type-inferred. An XLSX identifier cell
  stored as a number (which loses leading zeros and turns long barcodes into `6.22E+12`) is a row **error**
  `identifier_numeric_cell` with the fix "format the column as Text" (310). An identifier from a formula cell is an error.
- **No normalisation of identifiers** (310, 313): no case folding, no digit-script conversion. A `barcode` or `plu` that
  contains Arabic-Indic digits (`٠`–`٩`) is an error `identifier_non_ascii_digits`, because no scanner produces them
  and the value could never match a scan (OD-15).
- **Whitespace**: leading/trailing whitespace is trimmed from every cell before validation and the trim is counted as a
  notice (OD-10). After the trim, identifier and name rules apply unchanged.
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

Per row, in order, against **active** identifiers of the tenant, byte for byte:

1. **Stable source key**: `sku` (OD-1).
2. **Trusted exact identifiers**: every `barcode` and `plu` on the row.
3. **Nothing else.** Name is never a match key; there is no fuzzy or prefix match.

Outcome per row:

| Identifiers found | Result |
|---|---|
| None of the row's identifiers is active anywhere | `no_match` |
| All found identifiers resolve to one product | `match(product)` |
| Found identifiers resolve to two or more products | `ambiguous` → review (421) |
| The single product is retired | error `product_retired` (no un-retire through import) |
| The row has no identifier at all | `no_match`, plus review `no_identifier` on Create / Upsert (a product with no identifier cannot be scanned and cannot be re-matched by a later import) |

A row that matches a product and also carries an identifier that is free is an **identifier add** on that product. A row
whose identifier is active on a **different** product than the one its other identifiers match is `ambiguous`, never a
move (317).

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

- `error` rows are fixed in the file and re-uploaded (a new batch version, §8.3). V1 has no inline cell editing in the
  Console, so the file stays the provenance (OD-5 note).
- `needs_review` reasons: `ambiguous`, `no_identifier`, `possible_duplicate` (a Create row whose exact `name` equals an
  active product's name and that has no identifier match). Name equality is a **hint for a human**, never a match.
- Review resolutions, one per row, each recorded with actor and time: **create new**, **update product P** (only a
  product among the row's identifier candidates, or, for `possible_duplicate`, the named product), or **exclude row**.
- `excluded` exists only as an explicit, audited decision. **Publish is refused while any row is `needs_review` or
  `error`.** The merchant either fixes the file or excludes those rows explicitly.

## 8. Flow, lifecycle, idempotency, limits

### 8.1 Batch lifecycle

```
uploaded ──map──► mapped ──validate──► validated ──(all rows ready/unchanged/excluded)──► ready ──publish──► published
   │                ▲  │                  │  ▲                                              │
   │                └──┴──── re-map / re-validate ───────┘  └── review decisions ──────────┘
   └──────────── cancel / expire (any state before published) ──► cancelled | expired
```

- One **open** batch per tenant at a time (a second upload while one is open is `409 import_batch_open`, with the open
  batch's id), which keeps the preview honest and the publish lock simple. Cancel is explicit.
- A batch carries a `version`; every mapping change, re-validation or review decision increments it, and each call
  sends `expectedVersion` (`409 stale_batch`).
- An open batch expires after 7 days (`expired`), keeping its rows for audit.

### 8.2 Validation is bound to catalogue state (402, 403)

Validation stores, per matched row, the product's `updatedAt`, and a `previewHash` over the ordered row outcomes,
field diffs, identifier adds and mode. Publish requires the `previewHash` the merchant saw. Under the per-tenant import
publish lock, publish re-checks: every matched product's `updatedAt` unchanged, every identifier to add still free,
every referenced category and brand still active. Any difference → `409 stale_validation`, the batch returns to
`mapped`, and the merchant re-validates and sees a new preview (the spec 042 §3 pattern, simplified: any intersection
is stale).

### 8.3 Atomic publish (405, 450)

One database transaction for the whole batch: every product create / update, every identifier add, every audit row and
the batch's own `published` transition. Any failure rolls back everything; nothing is half-published. The existing
`catalog_change_log` triggers then carry the changes to the POS delta with no other step (F-10). The publish writes go
through the same domain functions as the console writes (same checks, same audit actions), so the import cannot
diverge from the single-product rules.

### 8.4 Idempotency

- **Upload**: `Idempotency-Key` through the existing interceptor; a replay returns the same batch. The file's SHA-256 is
  stored; uploading a file whose hash equals a batch published in the last 30 days is a warning that names that batch,
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
| XLSX | `.xlsx` only (`.xlsm`, `.xls`, `.xlsb` refused); uncompressed size ≤ 50 MiB; ≤ 200 zip entries; one sheet read | Zip-bomb and macro guard; type from magic bytes, never from the header or the file name (spec 039 FR-03) |
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
- Retention: staged rows of a published batch are kept 13 months, then reduced to the batch summary (OD-6).

## 9. Change Set: interim now, primitive later

Decision 400 and O-5 want catalogue changes to publish through the one shared Catalog + Pricing revision engine. It does
not exist (F-8). The issue's scope says: reuse it if it exists by build time, otherwise define the interim.

- **If RT-1484 has merged the shared `change_sets` primitive when S4 starts**: an import batch is a `catalog`-domain
  change set (header row in `change_sets`; the staged rows are its items). The §8.1 states map onto spec 042 §3
  (`mapped` ≈ `draft`, `validated`/`ready` ≈ `validated`, `published`, `cancelled`); approval uses the primitive's
  hook (OD-12); publish allocates a catalogue revision (407). This needs a Planning check of the primitive as built.
- **Otherwise (interim)**: the import keeps its own batch tables (§10) with the same state names, `version`,
  `previewHash` and publish lock, so a later slice can move the batch header into `change_sets` without changing the
  Console flow or the contract's observable states. The interim publish is an audited direct write, the same posture
  O-1 approved for the single-product console writes. No catalogue revision number is promised in the interim (407 is
  not yet met by any catalogue write on `main`).

## 10. Conceptual data model (for the S2 migration; not DDL)

- `catalog_import_batches`: `id`, `tenant_id`, `state`, `version`, `mode`, `file_name`, `file_size`, `file_sha256`,
  `file_kind` (`csv` | `xlsx`), `sheet_name`, `parser_version`, `mapping` (canonical field → column), `mapping_profile_id`,
  `preview_hash`, `counts`, `created_by`, `created_at`, `updated_at`, `published_at`, `expires_at`. FORCE RLS.
- `catalog_import_rows`: `batch_id`, `tenant_id`, `row_number`, `cells` (parsed text per source column), `status`,
  `outcome` (match result, candidate product ids, field diff, identifier adds), `issues` (`code`, `field`, `severity`
  error | review | warning | notice), `resolution` (+ actor, time), `matched_updated_at`, `product_id` (after publish).
  FORCE RLS.
- `catalog_import_mapping_profiles`: per-tenant saved header → field maps. FORCE RLS.
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
| 4 Review | One row at a time or a filtered list of `needs_review`; candidates shown with name and identifiers; resolutions: create new / update this product / exclude row | Exclusion is explicit and shown in the final counts |
| 5 Preview | Impact: products to create, products to update (field-level before → after), identifiers to add, rows excluded, unchanged, and "N new products without a price will not reach the tills" (403) | A `409 stale_validation` resets to Validate with a notice that the catalogue changed (UX-10.19) |
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

## 12. Proposed implementation slices (NOT created; each needs its own Definition of Ready)

Contract-first order. Each slice is one bounded issue; the gated kinds are named for the PR title.

| # | Slice | Work Mode | Surface | Gated | Depends on |
|---|---|---|---|---|---|
| S1 | **Import contract**: new `packages/contracts/openapi/catalog/catalog-import.yaml` — upload (raw body), get batch, set mapping, validate, list rows (keyset), review decision, preview, publish, cancel, template download, error-report download; error codes of §5–§8; rate-limit classes | Implementation (contract) | `services/backend-core/packages/contracts/` | `[GATED: contract]` | Owner decisions on this record |
| S2 | **Import schema**: the §10 tables, FORCE RLS, grants, domain-grants SQL, retention job hook | Implementation | `packages/db/drizzle/`, `apps/api/src/auth/grant-registry.ts` | `[GATED: migration]` | S1 |
| S3 | **Parser dependencies**: CSV and XLSX parsers in Backend-Core (OD-9), with `dependency-review` clean | Implementation | `services/backend-core/package.json`, `pnpm-lock.yaml` | `[GATED: deps/lockfile]` | OD-9 |
| S4 | **Upload, parse, map, validate** runtime: raw-body route with pre-auth and concurrency bound, magic bytes, XLSX bomb guards, mapping profiles, row validation, matching (§7.1), statuses | Implementation | `apps/api/src/catalog/catalog-import/`, `apps/api/src/common/json-body-limits.ts` | none beyond S1–S3 | S1, S2, S3 |
| S5 | **Review, preview, publish** runtime: review decisions, `previewHash`, publish lock, stale re-check, one-transaction publish through the console-catalog domain functions, audit, idempotency | Implementation | `apps/api/src/catalog/catalog-import/`, `console-catalog.write.service.ts` (extract shared functions, no wire change) | none beyond S1–S2 | S4; §9 check of RT-1484 |
| S6 | **Console client repin** to the S1 contract on `main` | Implementation | `apps/admin-console/` generated client and PIN | `[GATED: contract]` pin follow-up | S1 merged |
| S7 | **Console import workspace** (§11), Arabic / English copy, Playwright + axe, keyboard walk, forced colours; owner screen review first (Advisory G1 / G2) | Implementation | `apps/admin-console/src/catalog-import/` | none | S5 (runtime), S6 |
| S8 | **Verification**: 5,000-row Arabic XLSX and CSV, leading-zero and numeric-cell barcodes, `.xlsm` / bomb refusal, RLS isolation between two tenants, publish atomicity under injected failure, stale validation, idempotent replay, POS delta picks up published products and omits unpriced ones, latency budget | Verification | lab or CircleCI `api` / `admin-e2e` | none | S5, S7 |
| S9 | **Prices through Pricing** (Planning amendment, then Implementation): price columns produce one draft Price Change Set per batch | Planning → Implementation | spec 049 amendment; Pricing module | `[GATED: contract]` likely | RT-1484, RT-1485 Done |
| S10 | **Category create** (only if OD-3 chooses B): a governed category write and its use from import | Planning → Implementation | console-catalog contract | `[GATED: contract]` | OD-3 |

## 13. Acceptance criteria for this Planning item (RT-1489)

- [x] Field contract, identifiers and collisions (§5, §7.1), modes (§7.2), validation and review queue (§7.3), preview,
  impact and atomic publish (§8.2–§8.3), Change Set interim (§9), idempotency, audit and limits (§8.4–§8.7), prices
  (§6), contract-first slices per surface (§12), with options and recommendations (decision-record.md).
- [x] Slices named, none created.
- [x] 83329059 §8 points that touch import answered or listed for the owner (§11.1).
- [ ] Reviewed and merged as docs (this PR).
- [x] Linked Confluence draft: RETAIL page 86343681 (unpublished draft under the Catalog page 23461894; the owner
  publishes it on approval).
