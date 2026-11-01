### Added
- RT-626 `[GATED]`, owner authorization 2026-11-01 for the `auth.openapi.yaml`
  edit (RT-574 issue 5d): new public-auth rate-limit buckets and a failed
  sign-in alert.
  - `POST /auth/password-reset/request` is limited per email
    (`passwordResetPerEmail`, 5 per hour). An over-limit request still answers
    202 and sends nothing. A per-email limiter outage also answers 202 and
    sends nothing. The per-IP check before it keeps the RT-628 fail-closed 503.
  - `POST /auth/email/verify/confirm` is limited per client IP
    (`emailVerifyConfirmPerIp`, 20 per 15 minutes). It answers 429 with
    `Retry-After` over budget, and 503 with `Retry-After` on a limiter outage.
    The contract documents both responses.
  - New counter `auth_signin_failure_total{cause}`, where `cause` is
    `invalid_credentials` or `rate_limited`. It counts sign-in credential
    failures and sign-in 429s. It is an alert signal and never enforced.
  - New Datadog P2 monitor `p2-api-signin-failures`: warns at 50 and alerts at
    100 failed sign-ins in 15 minutes. These are starting defaults to
    calibrate. Apply it with `deploy/datadog/apply.mjs`.
