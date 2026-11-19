### Added
- RT-1513 `[GATED: migration]` (RT-291 Gate 5, slice S2; contract RT-1512, owner rulings O1-O5): the shipment
  Transfer runtime in Backend-Core. Nine operations under `/api/inventory/v1/shipment-transfers` (create, list, get,
  approve, cancel, dispatch, record receipt, list receipts, close), dark behind the per-tenant
  `tenant_inventory_settings.shipment_transfers_enabled` (default off, 404 until on). Migration `0124` adds the
  Transfer document (header, lines, receipts, receipt lines, discrepancies), one shared `inventory_reservations` table
  (source type `transfer`; approval reserves, dispatch consumes, cancel and expiry release by audited events), a per-tenant
  transit warehouse in `erpnext_warehouse_map` (`purpose = 'transit'`), the frozen transfer leg bodies, the delayed-transfer
  threshold setting (default 3 days) and `store_business_date()`; `0125` is the unique leg key. Dispatch writes
  `transfer_out` once and a `transfer_dispatch` work item in the same transaction; each receipt writes `transfer_in` in its
  disposition (damaged allowed) and a `transfer_receive` work item that exists only once its dispatch is confirmed, carrying
  the dispatch Stock Entry. Over-receipt is refused (409), a short receipt fabricates nothing, and a short-close is recorded
  in Backend-Core only (its ERP leg is not decided). All FORCE RLS; domain grants in
  `docs/operations/sql/shipment-transfers-domain-grants.sql`.
