### Added
- RT-630 (RT-574 residual risk R1, owner ruling O5): a report-only per-IP
  pre-auth counter. When `FailClosedAuthGuard` answers 401 (no credential, or
  a session cookie or bearer token that does not authenticate), the failure
  is counted per client IP and reported as `preauth_rate_limit_total{cause,
  outcome}` and `preauth_rate_limit_utilisation{cause}`, with a throttled
  warn log on `would_limit`. It never refuses a request and has no enforce
  mode. Off by default (`PREAUTH_RATE_LIMIT_MODE=off`); `report` turns it on.
  The ceiling (`PREAUTH_RATE_LIMIT_LIMIT`, default 300, per
  `PREAUTH_RATE_LIMIT_WINDOW_MS`, default 5 minutes) is an owner calibration
  number. The IP appears only in the Redis key, never in a label or a log.
