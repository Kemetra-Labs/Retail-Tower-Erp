### Added
- RT-1505 `[GATED: contract]` part B (spec 049 slice S4, lead go-ahead after the merge of part A): the runtime of three more
  `catalog/catalog-import.yaml` operations, `consoleSetCatalogImportMapping` (`PUT /api/v1/catalog/imports/{batchId}/mapping`),
  `consoleValidateCatalogImport` (`POST .../validate`) and `consoleListCatalogImportRows` (`GET .../rows`), which lose their
  `x-runtime-status: contract-only` markers (contract 1.0.4-draft, description text only: no operation or schema shape
  changes; the other seven operations stay contract-only until S5). A new batch now stores a mapping suggestion (header
  synonyms in English and Arabic, then the tenant's saved mapping profile, chosen by the most columns covered, then the
  most recent update, the smaller name and the smaller id) and the `mappingProfileId` it drew on. Set mapping checks the
  completeness rules, returns the batch to `draft` at the next version (`409 version_conflict`, `409 import_batch_closed`,
  `422 mapping_invalid`) and can save the mapping as a profile (an upsert by name that keeps the id; an empty or repeated
  header is never saved). Validate trims every cell and counts the trims, applies the field contract (numeric and formula
  identifier cells, hidden characters and Arabic-Indic digits in identifiers, the GTIN check digit as a warning, formula
  cached values, `is_active`, price columns recognised and never written), matches by SKU then barcode / PLU against the
  tenant's tenant-wide identifiers, applies Create / Update / Upsert and gives every row exactly one status with its
  review reason, field changes, identifier adds and brand to create; the batch becomes `validated` (next version, new
  validation generation) with its counts and a `previewHash`, and the matched product's `updated_at` is kept per row.
  Audited as `catalog.import.map` and `catalog.import.validate` (ids and counts only). The row list is keyset paginated by
  row number with a cursor bound to the validation generation and the `status` filter, and never answers an empty page for
  a batch whose rows were purged. `console-catalog.write-bodies.ts` exports the identifier pattern the import reuses. No
  migration, no new dependency, no package or lockfile change.
- RT-1505 part B review fixes: set mapping and validate answer `409 import_batch_closed` for a batch past its `expires_at`
  that the expiry job has not closed yet; a store-scoped identifier of a deleted store is absent from the store-scoped
  review (the console writes' `LIVE_STORE_SQL` is exported for it); every Unicode format character (Cf) inside an
  identifier is `identifier_invisible_char`; the matched product's `updated_at` is read as a UTC ISO instant, so the
  `previewHash` no longer depends on the session TimeZone or DateStyle.
