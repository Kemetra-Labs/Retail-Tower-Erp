### Added
- RT-1151 `[GATED]`, owner authorization on RT-1151 (D1, D5, 2026-11-19): migration
  `0121_pricing_core` (RT-282 PR-05), the Retail Pricing core schema: `change_sets` (the shared
  Change Set header), `price_books`, `price_zones`, `pricing_revisions` (immutable, gapless per
  tenant), `pricing_revision_stores`, `price_zone_memberships` and `price_events` (the immutable,
  effective-dated price timeline; overlaps refused by EXCLUDE constraints), all FORCE RLS, with
  `docs/operations/sql/pricing-domain-grants.sql`. Additive: the legacy price columns are
  untouched. No runtime uses the tables until RT-1484.
