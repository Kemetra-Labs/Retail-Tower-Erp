### Fixed
- RT-1248 follow-up: app shutdown waits for in-flight password-reset work for at most 5 seconds,
  well under Docker's default 10-second stop grace, so a hung database pool or email queue no
  longer uses up the whole shutdown window before the remaining hooks run. Abandoned work is
  logged as a count only (no email, IP or token).
