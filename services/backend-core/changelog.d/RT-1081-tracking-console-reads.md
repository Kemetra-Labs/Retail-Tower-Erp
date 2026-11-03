### Added
- RT-1081 `[GATED: OpenAPI contract]`, owner-approved 2026-11-03 (RT-455
  comment 15233, OD-0..OD-8; proposal
  `docs/decisions/rt-455-tracking-console-reads.md`): the tracking Console
  reads, contract and runtime together. `inventory.yaml` 1.10.0-draft adds
  `listTrackingHolds` (`GET /api/inventory/v1/tracking-holds`: status, kind,
  identity and product filters), `listInventoryRecalls`
  (`GET /api/inventory/v1/recalls`: summaries with hold counts),
  `getTrackingIdentity`, `getTrackingIdentityPositions` (per store and
  stocking unit, split by status and summed over the store's locations, OD-6)
  and `listTrackingIdentityExpiryCorrections` (`GET` on the correction path).
  The lists are keyset-paged as `listStockMovements` (RT-731). Identity reads
  answer a non-disclosing 404 to another role; hold, recall and correction
  reads a 403. `listInventorySafetyFindings` reserves the critical
  `tracking_consistency` kind (OD-8); nothing emits it yet.
  `catalog/tracking-profile.yaml` 1.2.0-draft adds `getTenantTrackingSummary`
  (`GET /api/v1/catalog/tracking-summary`, OD-5), which a store_manager may
  also call. Rate-limit classes in the same change. No migration.
