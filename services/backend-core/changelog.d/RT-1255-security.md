### Security
- RT-1255: the live POS operator re-verify (RT-137 / 031 G-4) now also refuses an operator
  whose user row is soft-deleted (or missing), with the existing `user_disabled` reason that
  sign-in uses. Before, the envelope kept working until its 8h expiry while the membership
  stayed active. Both callers (`PosOperatorAuthGuard`, `PosOperatorEnvelopeSaleGuard`) get
  it; refusals stay the same generic 401.
