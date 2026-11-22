# Module boundaries (RT-1453, RT-1525)

`pnpm lint:module-boundaries` (run by `pnpm lint:eslint`, so by `bc/fast` and `backend-fast`) fails when a
module reaches into another module instead of asking it for a port. It scans every `apps/*/src` tree
(today `apps/api/src` and `apps/worker/src`; no app name is hard-coded).

- **Module** = a logical name: a top-level directory of `apps/api/src`, of `apps/worker/src`, or of both.
  Same-named directories in the two trees are ONE module (an import between them is a same-module import,
  and both may name the module's tables); a module that lives only in the worker tree may own tables
  (`sync-failure-alert`). Files directly in an app's `src` are that app's composition root.
  `module-map.json` is the one place that declares which module owns which table, which modules are shared
  (`common`, `observability`) and any extra public file. Moving a table or a module is a one-line edit
  there; a name that is a directory in neither tree fails the check.
- **Worker ports.** A worker repository names only its own module's tables in SQL. For anything else it
  imports the owning module's worker port (`apps/worker/src/<module>/index.ts`), which runs on the
  caller's client. The worked example is `sync-failure-alert.repository.ts`, through `tenants`, `catalog`,
  `stores`, `memberships`, `auth` and `audit` (RT-1525). The worker violations that existed when the
  scanner reached the worker are in `baseline.json` (owner-approved once, in RT-1525) and may only shrink.
- **Public surface (the port convention):** another module may import only a module's root `index.ts`
  (the barrel with its ports), a root `*.module.ts` (Nest wiring) or a file listed in that module's
  `publicFiles`. Create an `index.ts` only for a module somebody needs a port from. A port that touches the
  database takes the **caller's `PoolClient`**, so the caller's transaction and RLS context stay in force and a
  preview and its write can share one evaluator.
- **Inverted port, when a direct import would cycle** (worked example: `STORE_PRICING_LIFECYCLE`, RT-1525).
  Pricing imports the stores port, so a Store write may not import Pricing (RT-1454). Stores declares what it
  needs instead: the interface and DI token live in `stores/store-pricing-lifecycle.port.ts`, exported from
  `stores/index.ts`. Pricing implements it (`pricing/store-lifecycle/`) and provides the token from a root
  `@Global()` module (`pricing/pricing-store-lifecycle.module.ts`) that only `app.module.ts` imports. The
  methods still take the caller's `PoolClient`, so the SQL stays in the owning module and runs in the caller's
  transaction. Not `common`: shared infrastructure never owns a module's tables.
- **Violations** are (1) a deep import of another module's internal file (type-only included) and
  (2) raw SQL naming another module's table after an UPPER-CASE `FROM|JOIN|INTO|UPDATE|TRUNCATE`.
  Drizzle table objects are not covered (`rulesdir/no-unscoped-tenant-query` polices tenant scope there).
- **`baseline.json` is shrink-only**, with an occurrence count per line (`file -> target`, `file :: table`),
  so a second violation in an already-baselined file also fails. A new line or a higher count fails; a line
  that no longer matches (or is counted fewer times) fails too: run `node tools/module-boundaries/check.mjs --update`
  in the PR that fixed it. `--update` refuses while any violation is new. Never add a line: build the port. A
  baseline edit that adds a line or raises a count needs the owner's approval in the PR. When a file moves,
  rename its keys by hand in the same PR (no count may rise).
- **Completeness (closed ownership, RT-1525):** every live migration table must be owned by exactly one
  module. "Live" means created by an up migration in `packages/db/drizzle`, minus a later `DROP TABLE`,
  with a later `ALTER TABLE ... RENAME TO` applied, in file order.
  - There is no `unownedTables` list; the key is rejected even when empty.
  - A table without an owner fails with exit 2 and a message that names the table, its migration and
    what to add.
  - A declared table that a migration dropped or renamed fails as stale, naming that migration.
  - `sharedTables` is an exception list of `{ "table", "reason", "approvedIn": "RT-<n>" }`. Adding an entry
    needs the owner's approval in the PR, the same rule as a baseline line.
- **Adding a table:** in the same PR as the migration, add one line to the owning module's `tables` in
  `module-map.json` (the module that will read and write it). Otherwise `lint:module-boundaries` fails.
  A migration-only PR selects `bc/fast` (the `migrations` tier of `tools/project-graph/graph.yaml`), so the
  check runs on it.
- **Known limits** (none occurs in the repo today): lower-case SQL keywords, concatenated or interpolated SQL
  (`${schema}.table`), a comma join's second table, `ALTER TABLE` / `LOCK TABLE`, `jest.mock` paths.
- Import cycles are a separate check (`tools/import-cycles`, RT-1454); this one reuses its scanner.
