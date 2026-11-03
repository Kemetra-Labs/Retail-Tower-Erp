### Added
- RT-451 slice S1 (owner authorization 2026-11-03 for the first RT-451
  implementation PR, no migration): the runtime of `posListTrackedLots`
  (`GET /api/pos/v1/products/{productId}/tracked-lots`,
  `pos-sales/tracked-lines.yaml`), which drops its `x-runtime-status:
  contract-only` marker. For one product at the caller's store it lists the
  batch lots that are not expired at the store's business date (inclusive,
  G7-5) and not under an active quality or recall hold, with the FEFO rank
  (`suggest` for an expiry-required product, else `off`; G7-13), the advisory
  sellable position (null until sale effects are activated) and the current
  Safety Revision. Read only; quantity never removes a lot. It accepts the
  operator envelope or the device token alone (`TrackedLotsAuthGuard`, a new
  reviewed composite), is rate-limited per device (`posReadTrackedLots`) and
  audited as `tracked_lots.listed`. It stays behind the new deployment gate
  `POS_TRACKED_SELLING_ENABLED`, off by default: while off it answers the
  non-disclosing 404 and reads nothing. The TLV, capture tracking, Tracking
  Resolution and the per-tenant activation flag are later RT-451 slices.
