### Changed
- RT-1284 `[GATED: production config]`, captain decision under owner delegation
  (RT-1284 comment 16231): `binViewReportSnapshot` now accepts a JSON body of
  up to 32 MiB, so a legal stock-view window (241 kB to 27.6 MB with ASCII
  names, with or without `tracking`) is no longer refused before validation.
  Every other route keeps the 100 kB default. A body above either limit now
  gets 413 `payload_too_large` instead of 500 `internal_error`.
