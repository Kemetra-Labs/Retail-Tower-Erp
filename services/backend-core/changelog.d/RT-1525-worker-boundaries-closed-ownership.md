### Changed
- RT-1525 (Phases 2 to 4): `lint:module-boundaries` now scans every `apps/*/src` tree, the worker
  included. A module is a logical name across the api and worker trees, and a worker-only module may own
  tables. `sync-failure-alert` owns its two tables, and its repository now reads tenants, failure counts,
  store names, recipients and addresses, and writes audit rows, only through the owning modules' worker
  ports, with unchanged SQL and behaviour. `unownedTables` is removed: every live migration table needs an
  owner, the error names the migration, a dropped or renamed table fails as stale (`RENAME TO` is now
  handled), and a `sharedTables` entry needs a reason and an approving RT issue. The worker violations
  that existed before are baselined once (owner-approved) and may only shrink. `audit-db-pool.ts` moved to
  `common/`, which removed 13 module-cycle edges from the import-cycle baseline.
