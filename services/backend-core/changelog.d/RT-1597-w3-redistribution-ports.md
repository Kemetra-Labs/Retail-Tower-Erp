### Added
- RT-1597: three internal W3 inventory ports for the W9 redistribution proposals (RT-1596 §3.1), exported from the
  inventory module and run on the caller's `PoolClient`: `readTenantAvailabilitySnapshot` (the A-1 Available-to-Sell of
  every active store, with each store's read time and placeholder limits of 50 stores and 20,000 rows),
  `readOpenTransferQuantities` (outbound draft and inbound draft, approved and in-transit quantities per store and
  product) and `createDraftTransfer` (the shipment Transfer create, now atomic with the caller's transaction; the HTTP
  create calls it unchanged). Stores answers inventory's new inverted port `INVENTORY_STORE_DIRECTORY`. No contract,
  migration or ATS formula change.
