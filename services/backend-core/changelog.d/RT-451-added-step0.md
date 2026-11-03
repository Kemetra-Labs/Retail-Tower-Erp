### Added
- RT-451 Step 0 `[GATED]`, owner authorization in the RT-451 description
  (amended 2026-11-03 after RT-455 comment 15233, OD-1, OD-2 and OD-9; design
  defaults approved by the owner 2026-11-03 via the coordinator): the
  contract-only Tracking Resolution contract, `inventory/inventory.yaml`
  1.9.0-draft. `listTrackingResolutionQueue` lists the `tracking_unresolved`
  sales with their unresolved lines in RT-731 keyset pages (owner /
  tenant_admin; a store_manager gets only `unresolvedCount` for its own
  stores). `bindTrackingResolution` is the owner-only, audited, idempotent
  bind of an existing identity to every unresolved line of one sale, which
  commits the sale's effects and ERP intent together (four new 409 codes).
  `listSaleLineFindings` lists the append-only sale-line findings
  (`unvalidated_tracked_line`, `sold_under_hold`, `erp_intent_held`) by kind
  and store, newest first. All three carry `x-runtime-status: contract-only`
  and have console rate-limit classes. `pos-sales/sales.yaml` 1.17.0-draft
  changes only wording: a `tracking_unresolved` sale is no longer a finding
  and surfaces only in the queue. No runtime, route or migration change.
