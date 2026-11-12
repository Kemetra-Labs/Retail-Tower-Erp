# @data-pulse-2/db

PostgreSQL schema, migrations, tenant context middleware, and tenant-scoped
query helpers for Backend-Core.

## Current Surface

- Drizzle schema files under `src/schema`.
- Explicit SQL migrations under `drizzle`, including `0000_initial.sql` and
  `0000_initial.down.sql`.
- Migration runner CLI under `src/cli/migrate.ts`.
- Tenant-scoped query helper in `src/helpers/with-tenant.ts`.
- Database tenant context middleware in `src/middleware/tenant-context.ts`.

## Commands

```bash
pnpm --filter @data-pulse-2/db build
pnpm --filter @data-pulse-2/db test
pnpm --filter @data-pulse-2/db migrate:up
pnpm --filter @data-pulse-2/db migrate:down
pnpm --filter @data-pulse-2/db migrate:status
```

Migration commands run against `DATABASE_URL` after the package is built.

## Migration numbers (RT-1344)

A new migration takes the number right after `main`'s tip: if the tip is
`0105_x.sql`, your first new file is `0106_<slug>.sql`, the next `0107_<slug>.sql`,
and so on, each with its `.down.sql` and registry fragment. Check the tip again
before you push; another PR may have taken your number.

CI (`bc/db-package`, spec `__tests__/cli/migration-numbers.spec.ts`) rejects:

- a four-digit number used by more than one migration, even under different slugs
  (the ledger key is the whole file name, so git and `_drizzle_migrations` would both accept it);
- on a pull request, new migrations that are not exactly the next numbers after the
  current tip of the PR's base branch (a reused number, a number below the tip, or a hole).

If it fails because `main` moved, renumber your migration (and its down file, registry
fragment, spec and probe) to the new next number; do not rename any migration already on `main`.

Do not back-fill the historical gaps (`0015`, `0049`, `0052`, `0053`, `0069`): a
late file there would be pending on a database that already applied the later ones,
and `up` would apply it out of order. The check allows the gaps that exist and
rejects any new file below the tip.

The check compares against the base branch tip fetched when the job runs. While
the `main` ruleset does not require branches to be up to date (RT-1238), two open
PRs can pass against the same tip and still merge as a duplicate; the `push` run on
`main` then fails on the duplicate number. Re-run the PR's `bc/db-package` job
after another migration PR merges.

## Design Principles

- PostgreSQL is the source of truth.
- Tenant-owned access must be scoped at the database and API layers.
- Migrations are reviewable release artifacts, not incidental generated output.
- Redis-backed helpers may support runtime behavior, but durable state belongs
  in PostgreSQL.
