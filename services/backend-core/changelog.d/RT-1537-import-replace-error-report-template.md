### Added
- RT-1537 `[GATED]`, owner delegation 2026-11-21: the product import serves its last three operations (spec 049 S5c, contract
  `catalog-import` 1.0.7-draft, additive text only). `consoleReplaceCatalogImportFile` replaces the file of an open batch (same
  raw-body intake and off-thread parse as the upload, the unchanged-header entries of the previous mapping carried and taking
  priority, the batch back to `draft` at the next version, idempotent by `expected_version`);
  `consoleGetCatalogImportErrorReport` downloads the `error` and `needs_review` rows as a UTF-8 CSV with a BOM, safe against
  formula injection; `consoleGetCatalogImportTemplate` downloads the header line in Arabic or English. No migration.
