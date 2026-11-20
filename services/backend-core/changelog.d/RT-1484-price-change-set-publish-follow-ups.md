### Fixed
- RT-1484 (RT-282 PR-10b follow-ups, the #749 review round 1): a `standard` Price Change Set whose
  earliest per-Store activation instant is at or before now plus the minimum lead time is stale
  at submit, approve and publish (409 `stale_validation`, back to draft), so a set approved in
  time but published late never publishes a past-dated price; emergency and rollback sets are
  exempt. Validation also counts a same-basis event whose wall-clock interval overlaps a line as
  replaced (a DST-gap boundary), and publish answers an unforeseen exclusion conflict as
  `stale_validation`, never a 500. Only a real Store activation writes the pricing bootstrap
  row. The transition audit rows carry `earliest_effective_at`, and `superseded` rows carry
  `preview_hash` and `reason_present`. The publish fan-out loads the Stores only when it needs
  them. No contract, migration, grant or dependency change.
