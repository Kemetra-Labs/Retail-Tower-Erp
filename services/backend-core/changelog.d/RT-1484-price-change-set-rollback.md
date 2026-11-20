### Added
- RT-1484 (RT-282 PR-10c, PR-6): `POST /api/v1/pricing/change-sets/{changeSetId}/rollback`
  (`consoleRollbackPriceChangeSet`) creates a new `kind: rollback` Price Change Set in `draft`
  whose items are generated from the target's Pricing Revision: in each interval where the head
  differs from the timeline before that revision, every price key and Zone membership the target
  touched returns to it; where the head already equals it, nothing is re-written. The set runs the
  ordinary lifecycle (validate, submit, approve by a second person, publish); its publish writes
  exactly one new `rollback` revision naming the target's, and the target becomes `rolled_back`.
  Owner decision: a rollback takes effect from publish time. An omitted `from` means "at publish";
  an explicit `from` more than 15 minutes in the past is `422 rollback_from_past`; `validate`
  regenerates the items from max(`from`, now) against the live Stores; a set whose earliest
  activation is more than 15 minutes past at publish is `409 stale_validation`. Rollback sets stay
  exempt from the lead time and the standard past-dated recheck. Activation is exact for
  `absolute` keys; a Book-scoped `store_local` key starts at the latest wall clock of the live
  Stores, so western Stores may activate it later than `from`, never earlier. A target whose keys
  later revisions touched is `409 rollback_blocked` with the blocking revisions, even when those
  revisions were themselves rolled back: author a corrective standard set. A rollback set is not
  rolled back, a key the items cannot express exactly is `422 rollback_unsupported`, and a rollback
  touching a retired Store, Zone or product validates with blocking findings (author a corrective
  set). Known v1 limitation: when a rollback must end an interval the target priced from nothing,
  later rows of older sets on that key are re-written at their own prices and those sets may become
  `superseded`. No Pricing operation is contract-only any more. No migration, grant or dependency
  change; no `price_history` write and no outbox event.
