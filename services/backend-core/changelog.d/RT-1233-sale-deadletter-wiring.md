### Fixed
- RT-1233: a failed sale-processing drain now reaches the operator. The worker
  wires `SaleSyncDeadletterProducer` into the `SaleProcessingProcessor` failure
  branch: a deterministic data error (SQLSTATE class 22/23, not the race codes
  23505 / 23P01) writes
  one open `needs-repair` dead-letter row and `failed-needs-repair` (listed by
  the Console needs-repair queue, and the job is not retried); any other error
  marks the sale `failed-retryable` (no row) and is rethrown for BullMQ backoff.
  A `synced` sale is never overwritten. Metric emission stays deferred.
