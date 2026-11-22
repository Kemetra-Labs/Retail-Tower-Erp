### Changed
- RT-1525 (Phase 1): the module-boundaries map now gives every pricing and catalog-import table an
  owner. `pricing` owns the 13 Retail Pricing tables and `catalog` owns the 3 `catalog_import_*`
  tables, so `lint:module-boundaries` now checks raw SQL against them. `unownedTables` drops from
  18 names to the 2 `sync_failure_alert_*` tables. The Store lifecycle writes take the pricing
  publish lock and write the bootstrap row through a new stores port, `STORE_PRICING_LIFECYCLE`.
  Pricing implements it from a `@Global()` module that only `app.module.ts` imports, and
  `common/pricing-store-lifecycle.ts` is deleted. The SQL, the lock key and the transaction
  position are unchanged, and `baseline.json` is unchanged.
