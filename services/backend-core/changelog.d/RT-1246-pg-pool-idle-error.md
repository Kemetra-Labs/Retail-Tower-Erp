### Fixed
- RT-1246: the api and the worker no longer exit when Postgres drops a pooled
  connection (SQLSTATE 57P01 on a database restart, Sentry BACKEND-CORE-7), whether
  the connection was idle or checked out inside a transaction. Every
  `InstrumentedPool` client now has an `error` listener that logs only the
  SQLSTATE as a warning; the pool opens a new connection on the next checkout.
