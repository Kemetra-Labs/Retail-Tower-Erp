### Fixed
- RT-1447: the sale-effects activation and the per-identity anchor stored their cut
  (`activated_at`, `sale_effects_activated_at`) as a millisecond-truncated JS `Date`, so an effect
  committed less than a millisecond before the transaction counted again as "since the anchor"
  (a rare double count in the identity and product positions, and a flaky db-package spec). The
  cut is now the database transaction timestamp itself. The reported `activatedAt` string is unchanged.
