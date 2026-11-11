### Added
- RT-1288 `[GATED: migration, contract]`, owner authorization on Jira RT-1288
  comment 16634: Backend-Core serves the ERP-origin stock import feed
  (`erpnext-connector/stock-import.yaml` 1.0.1-draft lifts the contract-only
  markers; wording only). `stockImportPullRequests` opens one import run per
  mapped bucket warehouse of an activated tenant (settle 300 s, run-start
  overlap 3900 s, 100 rows per page, a page that waits an hour for its report
  fails its run); `stockImportReportRows` records each page once and classifies
  every row (DC-4): an ERP-owned voucher without Retail provenance becomes one
  `erp_external` effect (`external`, `erp_confirmed_at` = SLE `creation`) at
  the primary/`sellable` position or the identity's hold status, a cancellation
  a `…:cancel` compensation; rows at or before the store's anchor snapshot are
  covered; everything else is a stored finding. Migration 0096 adds
  `erp_stock_import_runs`, `_pages`, `_rows` and `_findings` (FORCE RLS) and
  lets an `external` effect carry `erp_confirmed_at`; run
  `docs/operations/sql/erp-stock-import-domain-grants.sql` in step 2. The
  report route accepts up to 2 MiB, behind the RT-1295 pre-authentication.
