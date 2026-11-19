### Added
- RT-1512 `[GATED: OpenAPI]`, owner authorization in chat 2026-11-19: the Gate 5
  shipment Transfer contract in `inventory/inventory.yaml` (1.21.0-draft), nine
  contract-only operations under `/api/inventory/v1/shipment-transfers` (create,
  list, get, approve with a reservation, cancel before dispatch, dispatch,
  record and list receipts, close with an approved short-close), the lifecycle
  states and the typed 409 refusals of the RT-291 planning record. The ERP legs
  are reserved in `erpnext-connector/posting-feed.yaml` (1.16.0-draft) as the
  `transfer_dispatch` and `transfer_receive` work items (ERPNext goods in
  transit); no runtime emits them. Runtime: RT-1513.
