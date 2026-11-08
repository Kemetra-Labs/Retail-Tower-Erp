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
  S2 PR. How the POS and a store_manager learn the switch is an open owner
  decision, not in this version.
