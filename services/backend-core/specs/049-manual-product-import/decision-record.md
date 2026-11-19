# Spec 049 — Decision record (RT-1489)

Owner decisions this plan needs before slice S1 can reach Definition of Ready. Each lists the options, a
recommendation and what it changes. **Status of every item: OPEN, recommendation only.** Nothing here is ratified,
and the recommendations do not change any numbered Catalog decision (276–460) or Pricing decision.

| OD | Question | Recommendation | Blocks |
|---|---|---|---|
| OD-1 | Stable source key | **A**: SKU | S1 |
| OD-2 | Price columns before Pricing exists | **A**: notice, product unpriced | S1 |
| OD-3 | Missing category / brand in the file | **A** for categories, **B** for brands | S1 |
| OD-4 | Store overrides in V1 | **A**: excluded | S1 |
| OD-5 | Blank cell on Update; clearing a field; inline editing | **A**: blank = unchanged, no clear, no inline edit | S1 |
| OD-6 | Keep the original file? Retention | **A**: hash only; rows 13 months | S2 |
| OD-7 | Limits and sync vs job | **A**: 5 MiB / 5,000 rows, synchronous | S1, S4 |
| OD-8 | CSV encodings | **A**: UTF-8 only | S4 |
| OD-9 | Parser libraries | **A**: `csv-parse` + `read-excel-file`, verify first | S3 |
| OD-10 | Whitespace trimming | **A**: trim every cell, count it | S1 |
| OD-11 | Name the matched product in errors and review | **A**: yes, tenant-wide only | S1 |
| OD-12 | Approval before publish | **A**: none in V1; hook reserved | S5 |
| OD-13 | Audit granularity | **A**: batch events plus per-product rows | S5 |
| OD-14 | Change Set: interim batch vs wait for the primitive | **A**: interim, aligned to spec 042 | S2, S5 |
| OD-15 | Arabic-Indic digits in barcode / PLU | **A**: error | S1 |
| OD-16 | GTIN check digit | **A**: warning only | S1 |
| OD-17 | `is_active = false` through import | **A**: allowed, stated in the preview | S1 |

## OD-1 — Stable source key (decision 420)

420 says "stable source key first, then trusted exact identifiers". Spreadsheets from merchants rarely carry a system
id; most carry a SKU or item code, and many carry only barcodes.

- **A (recommended).** SKU is the stable key. Match order SKU → barcode / PLU. A row without SKU still matches by
  barcode / PLU. Simple, uses an identifier type that is tenant-wide by decision 303.
- **B.** A, plus optional `source_system` + `external_id` columns stored as the existing `external_pos_id` identifier
  (307 scoping), matched first. Useful when migrating from another POS; the type name says "POS", which fits that case
  only.
- **C.** A new generic `external_id` identifier type. Needs a contract and a migration of the type check; a broader
  identifier-registry change (301) that belongs to its own issue.

## OD-2 — Prices before RT-1484 / RT-1485

PD-2 (P-a) says a first price comes only through the Pricing change sets.

- **A (recommended).** Price columns are recognised, never written; notice `price_not_imported` per row; the preview
  states how many new products will be unpriced and absent from the tills (spec §6). S9 later turns them into a draft
  Price Change Set.
- **B.** Refuse any file that maps a price column. Clear, but merchants must delete a column they will need later.
- **C.** Hold import until Pricing ships. Avoids unpriced products, delays onboarding of names and barcodes.

## OD-3 — Category or brand named in the file that does not exist

Categories have no write API on `main`; brands do (`consoleCreateCatalogBrand`).

- **A (recommended for categories).** Row error `category_not_found` (exact name). The merchant creates the category
  first (today only through the seed CLI or support), or removes the column.
- **B.** Import creates missing categories as part of the batch, listed in the preview. Needs a governed category write
  first (slice S10, a contract change). Recommended **for brands**, because the brand write already exists: the preview
  lists "brands to create", created in the publish transaction with `catalog.brand.create` audit.
- **C.** Map to "no category / no brand" with a warning. Silent data loss in spirit; not recommended (419).

Owner note: if most first-time merchants bring categories, B for categories (S10) may need to come before S7.

## OD-4 — Store overrides, store availability, store-scoped identifiers

- **A (recommended).** Excluded from V1. One permission model (owner / tenant_admin, tenant-wide) per batch.
- **B.** Per-store availability columns (`store:<code>:active`). Adds store scope checks per cell and the
  `store_manager` question (361); better as its own slice after V1.

## OD-5 — Blank cells, clearing, inline editing

- **A (recommended).** On Update a blank cell leaves the field unchanged; V1 cannot clear `description`, `category` or
  `brand` through import (use the product edit screen); the Console does not edit cell values (the file stays the
  provenance; errors go back through the error report).
- **B.** A reserved clear token (for example `<clear>`). Powerful and easy to misuse in a spreadsheet; later.
- **C.** Inline cell editing in the Console. Breaks "the file is the source", doubles the validation surface.

## OD-6 — Original file and retention

- **A (recommended).** Do not store the file bytes: keep name, size, SHA-256, parser and mapping version, and the parsed
  cell text per row. Keep rows of a published batch 13 months, then the batch summary only. Cancelled or expired batch
  rows: 30 days.
- **B.** Also keep the original bytes in Postgres `bytea` (spec 039 OD-1 precedent) for the same 13 months. Better
  forensics; up to 5 MiB per batch of possibly sensitive merchant data.

## OD-7 — Limits and synchronous processing

- **A (recommended).** 5 MiB, 5,000 rows, 50 columns; validate and publish synchronous, one transaction at publish;
  latency budget measured in S8 (validate p95 ≤ 10 s, publish p95 ≤ 15 s). A merchant with more products splits the
  file.
- **B.** 50,000 rows with a worker job, progress and resumable validation. Needs a job and progress surface (Advisory G2)
  and a publish split that is no longer one transaction (405). Revisit if S8 or the pilot shows real catalogues above
  5,000.

## OD-8 — CSV encodings

Excel's "CSV (Comma delimited)" on an Arabic Windows locale writes Windows-1256, not UTF-8.

- **A (recommended).** UTF-8 only (BOM allowed); invalid UTF-8 → `encoding_not_utf8` with "save as CSV UTF-8, or upload
  the XLSX". XLSX is always Unicode, so the template recommends XLSX.
- **B.** Also accept Windows-1256 as an explicit choice in the upload step. Wrong choice silently garbles names, so it
  needs a preview of decoded names.

## OD-9 — Parser libraries (gated dependency change, S3)

npm registry, read 2026-11-19: `csv-parse` 7.0.3 (updated 2026-09), `read-excel-file` 9.3.17 (2026-11), `exceljs`
4.4.0 (last version change 2024), `xlsx` (SheetJS) frozen on npm at 0.18.5, newer builds only from the vendor CDN.

- **A (recommended).** `csv-parse` for CSV and `read-excel-file` for XLSX (read-only, small surface), in Backend-Core
  only. S3 must first verify: `dependency-review` (osv-scanner) clean, licence, cell type exposure (string vs number vs
  formula cached value, needed by spec §5), and that the zip limits of spec §8.5 can be enforced before inflation.
- **B.** `exceljs`. Full read / write (could also write the template and error report as XLSX), larger surface, slower
  release cadence.
- **C.** SheetJS from the vendor CDN. Not from the npm registry, so outside the lockfile and Renovate norms.
- **D.** Parse in the Console and send JSON rows. Keeps dependencies out of Backend-Core but makes the server trust a
  client parse (no file hash of what was parsed, two parsers if another client appears); not recommended.

## OD-10 — Whitespace trimming

The console writes store values as sent. Spreadsheet cells often carry stray spaces.

- **A (recommended).** Trim leading and trailing whitespace (Unicode `White_Space`, NBSP included, plus the bidi marks
  U+200E, U+200F, U+061C) of every cell before validation, and report the count as a notice. Such a character left
  inside an identifier is an error. Identifiers with outer whitespace are invalid on `main` anyway (F-5 pattern), so trimming makes them usable
  without changing any stored-byte rule.
- **B.** Never trim; such cells are errors. Faithful, but most real files would fail on invisible characters.

## OD-11 — Naming the matched product

`alias_conflict` on the single add never names the other product (FR-042). Import errors and review need it.

- **A (recommended).** Name the matched product (name and identifiers) for **tenant-wide** identifiers only. Import is
  owner / tenant_admin only, and those roles already read every product of the tenant (O-7), so nothing new is
  disclosed.
- **B.** Keep FR-042: say only "already in use". Makes `ambiguous` and `already_exists` rows unresolvable in the Console.

## OD-12 — Approval before publish (404)

- **A (recommended).** No approval step in V1 beyond the role and the consequence-aware confirm. The batch keeps an
  approval hook (the reserved `pending_approval` / `approved` states between `validated` and `published`) so the RT-284 policy engine, or the shared primitive's approval hook, can
  require independent approval later.
- **B.** Require a second owner / tenant_admin approval above a threshold (for example > 500 updates). Needs a policy
  setting and a pending-approval surface.

## OD-13 — Audit granularity

- **A (recommended).** Batch-level events (upload, map, validate, each review decision, publish, cancel, expire) plus the
  existing per-product and per-identifier audit actions at publish, each carrying `import_batch_id` and row number.
  Consistent with "catalogue writes are audited per mutation" (console-catalog.yaml, O-6).
- **B.** Batch-level events only, with the staged rows as the detail. Fewer audit rows (under A a 5,000-row batch can
  write about 40,000: one product write plus up to seven identifier adds per row), but the product's audit history would not show the change.

## OD-14 — Change Set primitive

- **A (recommended).** Build the interim batch now (spec §9, §10) with spec 042's state names, `version` /
  `409 version_conflict`, `previewHash` and publish-lock pattern, so it can move into `change_sets` (domain `catalog`)
  when RT-1484 lands. The check is made once, when S1 and S2 reach Definition of Ready: if the primitive is on `main`
  then, use it instead (a Planning check of the built primitive first).
- **B.** Block import on RT-1484 and a catalogue-domain change set. Fully aligned with 400 / O-5, but ties onboarding to
  the Pricing runtime schedule.

## OD-15 — Arabic-Indic digits in barcode / PLU

- **A (recommended).** Error `identifier_non_ascii_digits`: no scanner produces them, so such a value can never match a
  scan, and converting them would be identifier normalisation (310, 313).
- **B.** Convert to ASCII digits with a notice. Convenient; it is a normalisation rule the Catalog decisions do not
  allow without an owner decision.
- `sku` is not covered: a SKU is merchant text and may contain any script.

## OD-16 — GTIN check digit

- **A (recommended).** A digits-only barcode of length 8, 12, 13 or 14 with a wrong GS1 check digit is a **warning**
  (it may be a store-internal code that only looks like a GTIN).
- **B.** Error. Stops typos, also stops legitimate internal codes.

## OD-17 — Deactivating products through import

`is_active = false` on Update takes a product off every till at the next delta (the read-down sellable projection needs
the product active). It is the only way an import can remove something from sale.

- **A (recommended).** Allowed. The preview lists the count and the products ("N products will be taken off the
  tills"), and the publish confirm repeats it. A merchant often marks discontinued lines in the same spreadsheet.
- **B.** Ignore `is_active` on Update (Create only). Safer against a wrong column mapping; deactivation stays a
  per-product edit.
