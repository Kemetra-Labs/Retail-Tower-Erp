### Added
- RT-451 slice S2, contract first (`[GATED: contract]`, owner decisions
  OD-T1..OD-T5 and approval in RT-451 comments 16215 and 16216, 2026-11-08):
  `inventory/inventory.yaml` 1.12.0-draft adds the tenant's tracked-selling
  on/off switch, `getTrackedSellingSetting` and `setTrackedSellingSetting`
  (`GET` / `PUT /api/inventory/v1/settings/tracked-selling`), both
  `x-runtime-status: contract-only`. Tracked selling (batch / expiry) becomes
  an optional feature per tenant, off until the owner or tenant_admin switches
  it on. Switching on is refused with `409 tracked_selling_preconditions_unmet`
  while any of the six RT-50 Q13 preconditions (`TrackedSellingPrecondition`)
  does not hold; switching off is always accepted, and sales already in the
  Tracking Resolution queue stay resolvable. Both operations answer the
  non-disclosing 404 while the deployment gate `POS_TRACKED_SELLING_ENABLED`
  is off. Additive only; rate-limit classes `cheapRead` / `write`. No runtime,
  route or migration: the runtime ships with migration M1 in the next RT-451
  S2 PR. Reading the switch (OD-T6, RT-451 comment 16217): a store_manager
  reads its on/off value only; the POS reads the new optional
  `tracked_selling_enabled` on every answer of the POS inventory safety feed
  (`inventory/inventory-safety-feed.yaml` 1.1.0-draft; absent until the S2
  runtime, and absence means false). A switched-on tenant whose
  preconditions later fail stays on, shown to the owner as a warning (OD-T7).
