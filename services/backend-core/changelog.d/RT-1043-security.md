### Security
- RT-1043 (RT-625 D4): the public-auth rate-limit keys (sign-in pair, account and IP;
  password-reset request and confirm; email-verify confirm; invitation accept) are now an
  HMAC-SHA-256 of the normalized email and/or client IP under the new
  `PUBLIC_AUTH_RATE_LIMIT_KEY_SECRET`, so these buckets hold no raw email or IP (the
  `preauth_ip`, `pairing_ip` and `console_telemetry_ip` buckets still key the raw IP; a
  follow-up). Compound
  identifiers use a versioned, length-prefixed encoding. Limits, windows, check order and
  release rules are unchanged. The four IP buckets that were keyed by the raw address
  (`pwreset_ip`, `pwreset_confirm_ip`, `email_verify_confirm_ip`, `invitation_accept_ip`)
  now use the RT-625 P2 normalization, so an IPv6 client is bucketed by its /64 and an
  IPv4-mapped address shares its IPv4 form (IPv4 clients are unaffected). DEPLOY: the secret
  is required (compose and the api refuse to start without it, at least 32 characters) and
  the key change resets every public-auth counter once at deploy; add the secret to each
  environment first (`deploy/README.md`).
