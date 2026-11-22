### Added
- RT-1517 `[GATED: contract]`, owner decision in chat 2026-11-22 (recorded on RT-1517): `inventory.yaml` 1.22.0-draft adds
  `getShipmentTransfersSetting` and `setShipmentTransfersSetting` on `/api/inventory/v1/settings/shipment-transfers`, the
  HTTP surface of the RT-1513 activation switch, shaped like the Count Sessions switch. Owner or tenant_admin. Switching on
  is refused with 409 `shipment_transfers_readiness_unmet` while a readiness boundary does not hold; switching off is
  refused with 409 `shipment_transfers_in_flight` while a Transfer is in flight. While ON, the legacy instant transfer
  answers 409 `transfer_workflow_required`.
- RT-1517: a read-only operator CLI, `node dist/cli/transfer-drift.js report --tenant <uuid> [--json]`, lists the legacy
  instant-transfer legs still `not_posted` (the ERPNext drift they left), grouped by store, with item, quantity, unit and
  date. It posts nothing; the first Count Session or ERP reconciliation corrects ERPNext (RT-292).
