### Security
- RT-1262 (auth review F-001): the legacy local password reset no longer acts on a user
  with an ACTIVE external identity link, who signs in with the provider's password only.
  `password-reset/request` issues no token and sends no email for such a user (still 202),
  and `password-reset/confirm` consumes the token and answers the same generic 400 as an
  invalid token: no local hash is written, no session is revoked and no sign-in lockout is
  cleared. Provider-backed recovery stays with RT-937 item 3. No contract change.
