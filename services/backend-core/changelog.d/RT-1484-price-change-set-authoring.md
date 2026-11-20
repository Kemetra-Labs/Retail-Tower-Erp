### Added
- RT-1484 `[GATED: contract]` (RT-282 PR-09b, PR-4a), owner authorization on RT-1484 (comments
  17829 and the lead's decisions recorded there): the runtime of five
  `pricing/price-change-sets.yaml` 1.0.0-draft operations (list, create, get, update and cancel a
  Price Change Set), which lose their `x-runtime-status: contract-only` markers. Console owners
  and tenant admins (no Store Manager authoring, Q-B2) author `draft` sets with their item lists
  (migration 0123); every edit takes `expectedVersion` (409 `version_conflict`), increments the
  version and returns a validated set to `draft` with its preview discarded; a set is cancelled
  before publish; every write is idempotent and writes one `pricing.change_set.<transition>`
  audit row in its transaction. Writes are refused with 409 `pricing_authority_legacy` (the spec
  044 §6.1 code, added to the contract's `Conflict` description) unless the tenant is on the new
  `PRICING_AUTHORING_TENANT_ALLOWLIST` (comma-separated tenant UUIDs; empty = nobody, the
  production default), so no tenant publishes before its legacy import (RT-1485); reads stay open.
  Explain follow-ups (comment 17874): below the selected layer, the first defective layer and every
  layer after it report `none`, never `shadowed`; the explain `priceZoneId` description allows
  null for `no_price_book`. No migration and no grant change.
