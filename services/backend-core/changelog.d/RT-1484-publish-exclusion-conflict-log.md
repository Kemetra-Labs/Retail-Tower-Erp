### Changed
- RT-1484 (#750 review carry-over): an unforeseen exclusion conflict at Price Change Set publish is
  logged (tenant, set and constraint name only) before the set returns to draft, and its `stale`
  audit row carries `reason: "exclusion_conflict"`.
