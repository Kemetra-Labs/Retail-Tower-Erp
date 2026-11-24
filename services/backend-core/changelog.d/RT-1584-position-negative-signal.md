### Added
- RT-1584 (RT-1125 R-30, R-31): a status move or relocation that leaves its source position (store, product, location, status,
  tracking identity) below zero now raises the allow-and-flag signal (009 FR-024): the new unlabeled counter
  `inventory_position_negative_total` and `sourcePositionNegative` on the move's audit row (`null` when the probe failed).
  The move is never refused.
  A move never changes the store on-hand, so the existing `inventory_negative_balance_total` probe could not see it.
  No contract, migration or response change.
