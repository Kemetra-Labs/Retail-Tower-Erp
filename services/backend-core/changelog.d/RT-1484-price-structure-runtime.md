### Added
- RT-1484 `[GATED: contract]` (RT-282 PR-09a), owner authorization on RT-1484 (comment 17829):
  the runtime of the seven `pricing/price-structure.yaml` 1.0.0-draft operations, which lose
  their `x-runtime-status: contract-only` markers. Console owners and tenant admins create the
  tenant's retail Price Book with its default Zone (one per tenant, `price_book_exists`), create
  Zones and retire an unused one (`default_price_zone_immutable`, `price_zone_retired`,
  `price_zone_in_use` for an active membership, an active price event or a line of an open
  Change Set); store managers also read. Reads list a Zone's Stores at an instant and a Pricing
  Revision (keyset pages whose cursor fixes both) and a Store's membership timeline as known at a
  revision (422 `pricing_revision_unknown` above the head). Every write is idempotent and
  writes one audit row in its transaction; the Book create and the Zone retirement take the new
  per-tenant pricing publish lock. No migration; memberships still change only through Change
  Sets (later RT-1484 slices).
