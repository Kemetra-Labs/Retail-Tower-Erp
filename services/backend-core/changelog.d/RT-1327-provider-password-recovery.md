### Changed
- RT-1327 (RT-937 item 3): provider-backed password recovery for a user with an ACTIVE external
  identity link. `password-reset/request` asks the provider (Descope `password/reset`) to mail its
  own recovery link, after the 202 and under the same per-IP and per-email limits; it still issues
  no local token or email, and every provider outcome (unknown or unverified address, outage, no
  return URL) stays a silent 202. `password-reset/confirm` keeps its request body: a token the
  service does not hold is treated as the provider's one-time proof, verified at the provider
  (`magiclink/verify`), its session token verified and matched to an ACTIVE link, and only then is
  the new password set at the provider (`password/update`). Every provider session of the user is
  then ended with the same refresh token (`logoutall`, which invalidates all of the user's refresh
  tokens); it also runs when a later step refuses, so the session the proof opened never
  survives, and a failed sign-out is logged and does not fail the request, because the password
  has already changed. A linked user's reset request that the provider did not send (no return
  URL, outage, refusal) is logged server-side with its result kind only. No local hash is written, no Admin
  session is minted, and every Backend-Core session of the user is revoked; every refusal
  (invalid, expired or replayed proof, password policy refusal, no active link) is the same
  generic 400. A provider outage while verifying or updating is a 503 ("Identity provider
  unavailable"), as for sign-in and password change; the contract now declares 503 on
  `password-reset/confirm` (it also covers the RT-628 rate-limiter outage the route already
  answered with 503). Unlinked users keep the local reset. The recovery link returns to
  `<CONSOLE_BASE_URL>/reset-password?t=<proof>`: the api reads the same origin-only https
  `CONSOLE_BASE_URL` as the worker, and without it no provider reset is sent (fail closed). The
  deploy config must pass `CONSOLE_BASE_URL` to the api service (owner-gated). The only OpenAPI change is the added 503 above.
  For RT-807: the Admin page at `/reset-password` posts `{ token: <t>, new_password }` to the
  existing confirm route, removes `t` from the URL at once, and on 204 goes to `/signin`.
