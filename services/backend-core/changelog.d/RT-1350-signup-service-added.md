### Added
- RT-1350 `[GATED: contract]` slice 3: the customer self-signup service serves
  `POST /api/v1/signups` (`requestSignup`) and `POST /api/v1/signups/complete`
  (`completeSignup`) from `signups.openapi.yaml`, with fallback A (Backend-Core's own
  opaque, single-use, emailed token, stored only as a hash). Public routes with an Origin
  check, per-IP and per-address rate limits (a limiter outage fails closed with 503), a
  server-verified human challenge behind a provider-neutral port (Cloudflare Turnstile
  adapter; it fails closed until `TURNSTILE_SECRET_KEY` and `TURNSTILE_EXPECTED_HOSTNAME`
  are set), a bundled disposable-domain list, and `SIGNUP_CURRENT_TERMS_VERSION` (unset:
  503). `completeSignup` creates the owner user, the `active` tenant, the `owner` membership,
  the `restricted` entitlement and the consent record in one transaction and starts the native
  session; it completes at most once per pending signup. New email job `auth.signup-link`
  (worker template: draft wording, pending owner approval). Both operations lose their
  `x-runtime-status: contract-only` markers. No Console UI, purge worker or ERP provisioning.
