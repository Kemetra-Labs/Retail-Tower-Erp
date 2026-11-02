### Added
- RT-1057: worker outbox consumer for `inventory.movement.created` that only acknowledges
  the event, so rows end `delivered` at the first attempt instead of being retried as
  `UnroutableEventType` and dead-lettered. It has no side effects; the event stays emitted
  for a future projection. No emitter, migration or contract change.
