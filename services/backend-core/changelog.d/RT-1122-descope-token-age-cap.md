### Security
- RT-1122: the Descope session-JWT verifier caps token age (jose `maxTokenAge`,
  which also requires `iat`) at `DESCOPE_JWT_MAX_TOKEN_AGE_SECONDS`, default
  30600 s (the 8 h session TTL plus 30 min). An older token is refused through
  the same non-disclosing error; a malformed value fails the API at boot. The
  production compose passes the variable (blank keeps the default). New tests
  cover the age cap, `nbf` with the 5 s tolerance and HS256 key confusion.
