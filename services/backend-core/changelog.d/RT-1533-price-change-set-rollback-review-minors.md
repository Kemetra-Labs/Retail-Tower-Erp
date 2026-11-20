### Fixed
- RT-1533 (review minors of #753): rollback validate now answers a blocked or non-published
  target (`409 rollback_blocked` / `change_set_invalid_state`) before `409 price_book_missing`.
  The contract descriptions of validate and publish name the refusals added by RT-1484 PR-6
  (an unreadable rollback start time or an activation before it is `409 change_set_invalid_state`;
  publish's stale reason `rollback_store_population_changed`). Tests cover the validate-time
  activation guard. Spec 042 plan no longer suggests rolling back newest-first.
