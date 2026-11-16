### Added
- RT-1419 `[GATED: OpenAPI]`, owner authorization in chat 2026-11-16: the Count
  Session API contract in `inventory/inventory.yaml` (1.15.0-draft), eleven
  contract-only operations under `/api/inventory/v1/stores/{storeId}/count-sessions`
  (open, get, list, record observations, take the Count Cut, submit, variance
  lines, recount, approve, cancel, late-event findings), with the session
  states, the variance flags and the typed 409 refusals of RT-292 Gate 6. No
  runtime, no ERP field, and the legacy `recordStockCount` route is unchanged.
