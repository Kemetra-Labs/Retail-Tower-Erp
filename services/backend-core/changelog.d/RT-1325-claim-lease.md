### Fixed
- RT-1325 (RT-1125 R-03), owner authorization 2026-11-11 (in-flight claim lifetime only): an
  orphaned idempotency claim no longer stalls the Connector posting ack for 72 h. `@Idempotent`
  gains an opt-in `claimLeaseSec`; the ack, whose handler is guarded against a double run,
  claims for a 120 s lease, and the saved result keeps the full replay TTL. Every other route,
  POS sale capture included (owner decision), keeps the default claim lifetime. Release and completion are
  fenced to the caller's own claim (by its expiry, no migration). An app-ahead-of-database
  clock no longer loops on a lapsed claim (one retry, then 425). A failed claim release no
  longer replaces the handler's own error, and it is logged, as is a failed result save, with
  the claim's expiry.
