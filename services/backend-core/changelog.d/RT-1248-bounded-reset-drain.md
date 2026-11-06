### Fixed
- RT-1248 follow-up: app shutdown waits for in-flight password-reset work for at most 10 seconds.
  A hung database pool or email queue can no longer hold the close open until the process
  manager kills it. Abandoned work is logged as a count only (no email, IP or token).
