### Security
- RT-1248 (RT-147 probe 3): `POST /api/v1/auth/password-reset/request` no longer awaits the
  account lookup, the reset-token insert or the email enqueue before its 202. The controller
  starts that work after the per-IP, (email, IP) and per-email limiter checks and replies at
  once, so a known and an unknown email get the same reply after the same request-path work
  and the response time no longer shows whether the account exists. The 202 with no body,
  the RT-625/RT-626 budgets and the queue payload are unchanged. A failure in that work (for
  example a database error) used to answer 5xx; it now answers the contract's 202 and is
  logged with a fixed message and the error class only (no email, IP or token). App close
  waits for in-flight reset work, but does not hold back the pool or email-queue shutdown, so
  work caught by a shutdown can still fail (logged, nothing sent).
