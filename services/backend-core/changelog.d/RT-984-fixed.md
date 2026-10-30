### Fixed
- RT-984 (production config, owner decision 2026-10-30): the production
  compose passes every remaining setting the API reads, so `backend.env` can
  reach it: the off-by-default gates `POS_RETURNS_ENABLED`,
  `POS_REFUND_SETTLE_BEFORE_POST_ENABLED`, `POS_LEGACY_REFUND_ENABLED`,
  `DEVICE_TOKEN_EXPIRY_ENFORCED` and `AI_GATEWAY_ENABLED` (default `false`);
  `OUTBOX_AUDIT_ENABLED` and `TRUST_PROXY_REQUIRED` (default empty, so
  production audit stays on); and the rate-limit, cashier-admission and
  AI-reservation tuning settings (default empty, so the code default applies).
  `deploy/prod.env.example` documents them. Two stay unmapped on purpose:
  `ALLOWED_ORIGINS` (RT-336 single origin, CORS off) and
  `ERPNEXT_FEED_RESPONSIBILITIES_ENABLED` (until the RT-419 hold lift). The
  new `test/deploy/compose-api-env.spec.ts` fails when a name read in
  `apps/api/src` is neither mapped from the host variable of the same name nor
  excluded with a reason, and checks each default against the real parser. Behaviour is unchanged until an environment
  sets one of these.
