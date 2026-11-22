# Module boundaries (RT-1453)

`pnpm lint:module-boundaries` (run by `pnpm lint:eslint`, so by `bc/fast` and `backend-fast`) fails when a
module of `apps/api/src` reaches into another module instead of asking it for a port.

- **Module** = a top-level directory of `apps/api/src`. `module-map.json` is the one place that declares
  which module owns which table, which modules are shared (`common`, `observability`) and any extra
  public file. Moving a table or a module is a one-line edit there; a stale directory name fails the check.
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
- **Completeness:** every table the migrations create must be owned in `module-map.json`, in `sharedTables`
  or in `unownedTables`; a mapped table that no migration creates fails too (renamed or dropped).
- **Known limits** (none occurs in the repo today): lower-case SQL keywords, concatenated or interpolated SQL
  (`${schema}.table`), a comma join's second table, `ALTER TABLE` / `LOCK TABLE`, `jest.mock` paths.
- Import cycles are a separate check (`tools/import-cycles`, RT-1454); this one reuses its scanner.
