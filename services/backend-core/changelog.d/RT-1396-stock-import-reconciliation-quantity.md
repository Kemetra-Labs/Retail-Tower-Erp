### Changed
- RT-1396 `[GATED: OpenAPI]`, owner authorization 2026-11-14 (Jira RT-1396 comment 17048):
  `erpnext-connector/stock-import.yaml` 1.1.0-draft, contract only, no shape change.
  `StockImportRow.actualQty` is now the row's signed stock movement: for an untracked
  Stock Reconciliation ledger row (any purpose) whose ERPNext v16 `actual_qty` is 0, the
  connector reports its Stock Reconciliation Item's `qty − current_qty`, so an Opening
  Stock 0 → 10 is +10 rather than a lost 0 (bench, RT-1287 comment 17044). The DC-4 key
  adds `ledgerEntryRef` and `entryIndex`, so the out and in rows of a tracked Stock
  Reconciliation never share a key, and a cancellation's reverse row pairs with its
  original by base tuple and opposite quantity. Backend-Core ingestion (RT-1288 follow-up)
  and the connector reader (RT-1287) implement it next; the stock import stays unscheduled.
