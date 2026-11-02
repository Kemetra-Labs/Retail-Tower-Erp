### Fixed
- RT-1065: the outbox drainer now dead-letters an event with no registered consumer
  directly on its final attempt (`last_error = UnroutableEventType`), instead of
  leaving it `claimed` until `ClaimLeaseExpired` and logging a spurious
  `drainer.markFailed failed`. Non-final attempts and the consumer-throw path are unchanged.
