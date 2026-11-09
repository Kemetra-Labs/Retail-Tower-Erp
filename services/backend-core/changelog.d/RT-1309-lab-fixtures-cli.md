### Added
- RT-1309 (S1 of the RT-1308 design, owner-approved 2026-11-09): lab-only CLI
  `apps/api/src/cli/lab-fixtures.ts` (`status`, `provision`, `provision --dry-run`) that provisions
  synthetic POS cashiers for load tests: a Descope Test User plus the Backend-Core user, active
  identity link and `store_staff` membership cashier admission requires, without email or
  invitation. Four fail-closed guards run before any write: `RT_LAB_FIXTURES=enabled` (passed per
  invocation, never in compose) and the
  database's own name (`rtlab`); a synthetic tenant allowlisted in code whose name carries
  `(synthetic)` and an active store of it; the lab Descope project and a verified `test=true`
  identity; a role that is neither superuser nor BYPASSRLS. Idempotent per fixture; refuses
  instead of re-pointing links. No HTTP route; no change to admission, sales, posting, invitation
  or sign-in code. Not deployed or enabled anywhere yet.
