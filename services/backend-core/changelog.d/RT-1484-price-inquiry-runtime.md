### Added
- RT-1484 `[GATED: contract]` (RT-282 PR-08b), owner authorization on RT-1484 (comment 17829):
  the runtime of the three `pricing/price-inquiry.yaml` 1.0.0-draft operations, which lose their
  `x-runtime-status: contract-only` markers. Console owners, tenant admins and store managers (own
  Stores only) read the price of a product in a Store at an instant, its timeline over a window of
  at most 366 days, and "why this price" (the Store, Zone and Book layers with what the selected
  price shadows, and the next published change), each as known at a Pricing Revision (422
  `pricing_revision_unknown` above the head). Resolution reads Pricing data only through the
  spec 041 resolver, which now also exposes its per-layer trace; there is no legacy fallback.
  Another tenant's or an out-of-scope Store or product is the non-disclosing 404. No migration and
  no grant change.
