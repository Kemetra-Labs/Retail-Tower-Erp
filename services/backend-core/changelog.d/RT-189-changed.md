### Changed
- RT-189 `[GATED: OpenAPI description-only]`: the reconciliation run GET
  (`getReconciliationRun`) returns `summary.bin_view_report` as metadata only
  (`complete`, `windowsRecorded`, `acceptedEntryCount`, `readAt`, `recordedAt`,
  `attemptRef`), never the stored `entries`, so the body stays under 10 KB for a
  full 20 x 500 report; the reduction is done in SQL so the report is not read
  into the API. Pre-RT-175 reports read with the `normalizeStored` defaults.
  `reconciliation.yaml` 1.5.0-draft states this on `ReconciliationRun.summary`
  (no schema change). The console sync-ops run list now returns only the integer
  counts as `mismatchSummary`, per its existing `additionalProperties: integer`
  contract. Worker readers and `STOCK_RECONCILIATION_RUN_COLUMNS` are unchanged.
