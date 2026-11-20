### Fixed
- RT-1484 PR-4b review follow-ups (#746, lead decisions of review round 4): a set_price equal to
  the head price is no longer dropped as unchanged when the same set ends or resets that key at or
  before its start; validations of one tenant serialize under a transaction-scoped
  `pricing-validate` advisory lock (after the set's row lock) so the second sees the first as
  `conflicts_pending`; a malformed preview cursor is 400 before any read; a helper line whose
  Stores disagree stores no `new_price`, and each preview row carries its own Store's
  `roundedFrom`; the `lead_time_violation` description says v1 applies a fixed minimum of 0
  (description only).
