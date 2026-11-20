### Added
- RT-1484 (RT-282 PR-10c, PR-6): `POST /api/v1/pricing/change-sets/{changeSetId}/rollback`
  (`consoleRollbackPriceChangeSet`) creates a new `kind: rollback` Price Change Set in `draft`
  whose items are generated from the target's Pricing Revision: from the rollback instant
  (`from`, default now) on, every price key and Zone membership the target touched returns to the
  timeline that revision superseded. The set runs the ordinary lifecycle (validate, submit,
  approve by a second person, publish); its publish writes exactly one new `rollback` revision
  naming the target's, and the target becomes `rolled_back`. A target whose keys later revisions
  touched is `409 rollback_blocked` with the blocking revisions; rollback sets are exempt from the
  lead time and the past-dated recheck. No Pricing operation is contract-only any more. No
  migration, grant or dependency change; no `price_history` write and no outbox event.

### Changed
- An unforeseen exclusion conflict at publish is logged (tenant, set and constraint only) and its
  `stale` audit row carries `reason: "exclusion_conflict"`.
