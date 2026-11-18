### Changed
- RT-1456 (audit A-10, pool part): `PG_POOL` and `AUTH_LOOKUP_POOL` are now provided by a global
  `DatabaseModule` (`apps/api/src/database/`, public entry `index.ts`) instead of `AuthModule`. Token
  values, the pool factories and the production fail-closed checks on `AUTH_LOOKUP_DATABASE_URL` are
  moved verbatim, so `overrideProvider(PG_POOL)` keeps working; the role/grant boot verifier
  (`DatabasePoolBoundaryVerifier`) stays in `auth/`. `auth.module.ts` no longer provides, exports or
  re-exports the pool tokens, and every importer now imports the tokens from `database` (tests that need the factories import `database/database-pools`). `REDIS_CLIENT`
  stays in `AuthModule` for now (its factory depends on auth internals). No route, contract, table or
  wire change.
