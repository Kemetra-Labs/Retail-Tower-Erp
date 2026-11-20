### Changed
- RT-1532 `[GATED: migration]` (RT-1484 follow-up): a Price Change Set rollback's requested start is stored on the set
  itself. Migration 0127 adds `change_sets.rollback_from` and `rollback_from_defaulted` (nullable; a CHECK allows them
  only on a `rollback` set and only together), and migration 0128 backfills them from each rollback set's first
  `pricing.change_set.created` audit row through `price_change_set_backfill_rollback_from()` (idempotent, FORCE RLS
  safe; the deploy re-runs it once the new API is up). The rollback create writes the columns and `validate` reads them,
  so it no longer reads an audit row (the `readFirstAuditMetadata` port is removed). A rollback set whose columns are
  NULL (no readable audit row) is still refused at validate with `409 change_set_invalid_state`. No contract change.
