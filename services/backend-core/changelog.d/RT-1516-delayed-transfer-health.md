### Added
- RT-1516 `[GATED: contract]`, owner decision in chat 2026-11-22 (recorded on RT-1516): `console-system-status.openapi.yaml`
  1.1.0-draft adds an optional `shipmentTransfers` component, the delayed-transfer health alert (W3 S07-D02). It is
  `degraded` when a `transfer_dispatch` / `transfer_receive` work item is `rejected` or `reconciliation_required`
  (`postings_need_attention`), when one has been `pending` for more than 60 minutes (`postings_stuck`), or when a Transfer
  has been in transit longer than the tenant's `delayed_transfer_threshold_days` (`transfers_delayed`); otherwise `ok`. It
  counts in `overall` and clears when the Transfer is received or the posting confirmed. Read under the tenant's RLS
  through the inventory port `readShipmentTransferHealth`; no new alert framework, no external notification.
