### Security
- RT-1580: the Descope session-token verifier now refuses impersonation tokens (`act`
  or `dact` claim) and any token whose `drn` is not exactly `DS`, so a support user's
  impersonated token can no longer be accepted as the impersonated operator. Both
  refusals use the existing generic rejected error with no claims.
