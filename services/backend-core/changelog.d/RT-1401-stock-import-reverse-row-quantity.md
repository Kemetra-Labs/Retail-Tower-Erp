### Changed
- RT-1401 `[GATED: OpenAPI]`, owner decision 2026-11-15 (RT-1398 PR #593 session): contract text only,
  `erpnext-connector/stock-import.yaml` stays 1.1.0-draft, no shape change. `StockImportRow.actualQty`
  of the reverse row of a cancelled untracked Stock Reconciliation (ledger row with no bundle and no
  `batch_no`, `isCancelled` true, `actual_qty` not 0) is the negation of the same difference,
  `-(qty − current_qty)`, instead of the ledger `actual_qty`. ERPNext v16 stores the balance before
  the reconciliation on that row (bench: 10 → 12 cancelled stores +10, movement −2), so passing it
  through never paired with its original. The reverse row is now the exact negation of its original,
  which is what the DC-6 cancellation pairing (RT-1397) requires. The connector reader implements it
  in RT-1398; the stock import stays unscheduled.
