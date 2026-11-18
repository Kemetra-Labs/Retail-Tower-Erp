### Changed
- RT-1453: store deletion (preview and write) and the Console open-shifts list read open shifts through a new
  `pos-shifts` port (`readStoreOpenShifts`, `countStoreOpenShifts`, exported from `pos-shifts/index.ts`) on the
  caller's client, instead of querying `shifts`, `users`, `devices`, `auth_tokens` and `cashier_admissions`
  themselves. The deletion preview's `force_close_eligible` is now the Console stuck verdict itself, not a second
  SQL copy of it. No HTTP contract change.
