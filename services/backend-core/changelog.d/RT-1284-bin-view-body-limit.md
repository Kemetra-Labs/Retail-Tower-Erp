### Changed
- RT-1284 `[GATED: production config, contract]`, captain decisions under owner
  delegation (RT-1284 comments 16231 and 16234): `binViewReportSnapshot` now
  accepts a JSON body of up to 32 MiB, so a legal stock-view window (241 kB to
  27.6 MB with ASCII names, with or without `tracking`) is no longer refused
  before validation. Every other route keeps the 100 kB default. A JSON body
  above either limit now gets 413 `payload_too_large` instead of 500
  `internal_error`. Because the body is read before authentication, at most 2
  snapshot bodies above 100 kB are read at once; a further one gets 503
  `snapshot_busy` with `Retry-After` before its body is read
  (`erpnext-connector/stock-view.yaml` 1.5.0-draft, additive).
