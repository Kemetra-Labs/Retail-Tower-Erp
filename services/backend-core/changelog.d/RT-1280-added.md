### Added
- RT-1280 `[GATED]`, owner authorization on RT-1280 (2026-11-08): membership invitations
  are delivered through Amazon SES (`@aws-sdk/client-sesv2`, new worker dependency) and
  carry an Admin Console accept link, `<CONSOLE_BASE_URL>/accept-invitation?token=…`, in
  Arabic and English. New worker settings `EMAIL_TRANSPORT`, `EMAIL_FROM`, `SES_REGION`,
  `CONSOLE_BASE_URL` and the secret `EMAIL_SES_ACCESS_KEY_ID` / `EMAIL_SES_SECRET_ACCESS_KEY`
  (worker container only). In production the worker refuses to boot unless SES is fully
  configured; NoOp is allowed only outside production. Set the values before deploying
  (`deploy/README.md`).
