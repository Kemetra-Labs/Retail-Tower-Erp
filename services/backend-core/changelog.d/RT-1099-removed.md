### Removed
- RT-1099 `[GATED: contract]`, owner-approved 2026-11-03: the retired
  sale-linked backfill (RT-289 Q3, RT-425, RT-427). `inventory.yaml`
  1.11.0-draft drops the deprecated, contract-only, never-served
  `backfillSaleLinkedMovements` (`POST /api/inventory/v1/admin/sale-linked-backfill`)
  and the components only it used (`SaleLinkedBackfillCommand`,
  `SaleLinkedBackfillItem`, `SaleLinkedBackfillResult`, the `RateLimited`
  response, the `platformAdmin` scheme, the `inventory-admin` tag); oasdiff
  rates it INFO, acknowledged in `tools/oasdiff/breaking-ignore.txt`
  (`consumer:admin`: generated types only, no call site).
  `InventoryService.backfillSaleLinkedOutbound` and its input type, which had
  no production caller, are removed with their specs; the restock backfill
  (`backfillRestockInbound`) is unchanged and now covers the outbox dedup
  assertion. No migration.
