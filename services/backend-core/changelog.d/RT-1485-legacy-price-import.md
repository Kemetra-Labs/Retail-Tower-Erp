### Added
- RT-1485 (spec 044 PR-16a-2a): the operator CLI `pricing-legacy-import` runs a tenant's initial
  legacy price import into Pricing in one transaction. It creates the retail Price Book and default
  Zone from the declared MC-10 inputs, then publishes the `legacy_import` Change Set as revision 1:
  one `store_local`, open-ended event per priced live `tenant_products` or `store_product_overrides`
  row, with the MC-1 starts. Zero and sub-minor prices are reported and not imported. It refuses
  when the tenant is not on `legacy` authority, holds more than one legacy currency, has
  `price_history` rows, or has a Book with other inputs. A re-run with no legacy change writes no
  revision; a changed legacy price is refused until the delta publication is decided. There is no
  scheduled run. `app.system_privilege` gains `pricing_legacy_import`, and the domain role gains
  `SELECT, INSERT` on `pricing_import_runs` (`pricing-authority-domain-grants.sql`, release step 2).
