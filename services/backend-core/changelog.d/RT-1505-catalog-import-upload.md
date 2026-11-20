### Added
- RT-1505 `[GATED: contract]` part A (spec 049 slice S4, authorization on RT-1505 and its comments 17873 and 17947): the
  runtime of two `catalog/catalog-import.yaml` operations, `consoleUploadCatalogImport` (`POST /api/v1/catalog/imports`)
  and `consoleGetCatalogImport`, which lose their `x-runtime-status: contract-only` markers (contract 1.0.3-draft; the
  other ten operations stay contract-only until part B and S5). Owners and tenant admins upload a raw CSV or XLSX (5 MiB,
  any `Content-Type`, read only after the session, tenant and role guards, behind a bound of four bodies at once: one
  more is `429 rate_limited`); the type comes from magic bytes only, and an in-house zip guard (entry count, declared and
  real sizes, `vbaProject.bin`, `.xlsm`, OLE2, lying headers, hidden entries) runs before `read-excel-file`. A sheet-XML
  pre-scan marks formula cells (F1) and bounds what the library may allocate; a CSV is strict UTF-8 with no NUL; limits
  are 5,000 data rows, 50 columns, 2,000-character cells and 1,048,576 physical rows (new 422 `file_too_many_rows`).
  Upload is idempotent by key + file SHA-256 + canonical query (replay, `409 idempotency_key_conflict`), allows one open
  batch per tenant (`409 import_batch_open` naming it) and writes the draft batch, its staged rows and one
  `catalog.import.upload` audit row in one transaction. `GlobalExceptionFilter` now surfaces `error.openBatchId`. The
  shared raw-body reader moved from `tenant-branding/logo-body.ts` to `common/raw-body.ts` (no behaviour change).
  `knipUnusedDependencies` is back to 0. No migration, no new dependency.
