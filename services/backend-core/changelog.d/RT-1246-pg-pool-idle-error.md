### Fixed
- RT-1246: the api and the worker no longer exit when Postgres terminates an idle
  pooled connection (SQLSTATE 57P01 on a database restart, Sentry BACKEND-CORE-7).
  Every `InstrumentedPool` now has an `error` listener that logs the SQLSTATE as a
  warning; pg-pool has already dropped the dead connection and opens a new one.
