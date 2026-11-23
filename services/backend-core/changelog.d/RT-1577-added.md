### Added
- RT-1577 `[GATED: contract]`, RT-1511 slice S2: `posGetStoreAvailability` (`GET /api/pos/v1/inventory/availability`, new
  `inventory/pos-availability.yaml` 1.0.0-draft). A device-authenticated, store-scoped, paged snapshot of Available To Sell
  and its band (`in_stock`, `low`, `out`) for the store's sellable catalogue, with `asOf` on every page. Computed on read
  by the S1 rules; the product set is the catalogue read-down's. Additive: a new file, no existing operation changes; no
  migration, no new table, no ERPNext read.
