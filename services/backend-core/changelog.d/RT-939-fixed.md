### Fixed
- RT-939 (no OpenAPI, migration, RLS policy, dependency or deploy change):
  `packages/db/src/cli/bootstrap-pilot.ts` is idempotent for a non-superuser
  role, not only for a superuser. The existing-tenant slug lookup ran before
  the seed set its tenant GUCs, and `tenants` has FORCE ROW LEVEL SECURITY, so
  a re-run as the app role saw no tenant, inserted a second one and failed on
  `tenants_slug_active_uidx`. The lookup now runs under the same
  transaction-local `app.is_platform_admin = 'true'` (with the nil tenant) that
  the seed already uses for the tenant insert. The bootstrap-pilot
  Testcontainers spec re-runs the seed as the app role instead of the
  superuser.
