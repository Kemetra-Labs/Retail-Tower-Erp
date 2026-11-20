### Fixed
- RT-1484 (#752 review round 2): a rollback now ends the target's price wherever the timeline
  before it had no price, even when that gap starts inside a restored interval (a bounded promo
  under an open price no longer leaves the open price in force after the promo). A rollback set is
  validated against one Store snapshot, and publish refuses (`409 stale_validation`) a rollback
  whose preview activates before its start or misses a Store of its population. An explicit
  rollback start that cannot be read back refuses validation instead of falling back to now. A
  rollback draft that can no longer validate (blocked, unsupported, or its start time unavailable)
  can only be cancelled. Blocked-rollback guidance now points to a corrective standard set.
