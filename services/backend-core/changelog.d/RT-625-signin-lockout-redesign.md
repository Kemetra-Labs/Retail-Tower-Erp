### Security
- RT-625, owner decisions D1–D3 (2026-11-01, review
  `docs/decisions/rt-625-signin-lockout-review.md`): one IP can no longer lock
  an account out, or block its password reset, from another IP.
  - Sign-in adds a failure-only bucket per (email, client IP), `signin_pair`,
    at 5 per 15 minutes. The per-account bucket is raised to 20 per 15 minutes.
    `signin_ip` is unchanged at 30 per hour. The buckets are checked pair, then
    account, then IP. A refusal gives back every reservation taken before it.
    A success, or any error other than a credential failure, gives back both
    failure-only hits. Accepted knowingly: a few IPs can still lock an account
    (4, or 3 that time their bursts around the fixed pair windows; one IP adds
    at most 9 per account window), and the distributed guess budget rises from
    480 to 1,920 per day.
  - `password-reset/request` limits reset emails per (email, client IP) at 5
    per hour and per email at 20 per hour. This replaces RT-626's 5 per hour per
    email. An over-limit request still answers 202 and sends nothing.
  - A successful `password-reset/confirm` clears that email's account bucket
    and the confirming IP's pair bucket. A failed or expired confirm clears
    nothing.
  - IP keys use the IPv6 /64 prefix and turn IPv4-mapped addresses into IPv4.
    Pair keys are length-prefixed, so two different pairs never share a key.
  - Boot refuses `TRUST_PROXY=true` in a deployed environment. It also refuses
    `TRUST_PROXY=false` (and a hop count of `0`) unless `TRUST_PROXY_DIRECT_DEPLOYMENT=true` declares a
    deployment with no proxy. A hop count, and the RT-624 handling of an unset
    value, are unchanged. This changes RT-624's rule that an explicit `false` is
    silent (owner approval, RT-625 comment 15095).
  - The Redis outage posture is unchanged: sign-in fails closed with 503 and
    `Retry-After: 30`. Releases now run in parallel; the worst case is about
    4 s at the default 1 s limiter timeout.
  - No contract, migration or dependency change.
