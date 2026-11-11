### Added
- RT-1286 `[GATED: OpenAPI]`, owner go-ahead 2026-11-11 (RT-1286 comment 16540,
  RT-1283 comment 16534; Inventory Gate 8 planning record §3 (b) and (c), approved
  in RT-293 comment 16226): contract-only Gate 8 contracts. New
  `erpnext-connector/stock-import.yaml` 1.0.0-draft defines the ERP-origin stock
  import feed: `stockImportPullRequests` (Backend-Core offers one keyset page of
  Stock Ledger reads per mapped bucket warehouse, positioned by `creation`,
  `ledgerEntryRef` and `entryIndex`, with a settle bound on every read and an
  overlap window on each run's first page) and `stockImportReportRows` (the
  Connector reports the ledger facts it read, one row per ledger row or Batch
  entry, or a refusal; `Idempotency-Key` required). Facts only, no
  classification and no valuation on the wire (G8-7). The DC-4 key is built
  from voucher type, voucher number, detail row, warehouse and Batch, so one
  voucher row's effects at two warehouses never share a key. Both operations
  are `x-runtime-status: contract-only` (RT-1287 Connector reader, RT-1288
  Backend-Core ingestion).
  `erpnext-connector/posting-feed.yaml` 1.11.0-draft reserves the work-item kind
  `inventory_disposition` (scrap / vendor return) with unreferenced
  `InventoryDispositionWorkItem`, `InventoryDisposition` and
  `InventoryDispositionLine` schemas. The wire is unchanged: `PostingWorkItem.kind`
  keeps `sale_post | reversal`, and Backend-Core must not emit the kind until
  the Connector accepts it (Post-Pilot P5/P6).
