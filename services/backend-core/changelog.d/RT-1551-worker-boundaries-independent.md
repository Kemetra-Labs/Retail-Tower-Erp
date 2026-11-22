### Changed
- RT-1551 (part 1): the worker no longer reaches into other modules for the 22 module-boundary lines
  that do not depend on who owns the catalog tables.
  - Worker-factory types come from the `email` port, and `errorFields` from `common`.
  - Sentry's failed-job tags read each job name from its module's `index.ts`. The email and audit
    names sit in side-effect-free `job-names.ts` files.
  - The AI usage sweep lists tenants through the shared `tenants` port. The RT-1389 platform-admin
    allowlist shrinks to 26.
  - The replay purge moved to `apps/worker/src/pos-cashier-admissions/`, the module that owns
    `cashier_admission_requests`.
  - The outbox gauge's SQL moved to `outbox`, bound by the worker root through `OUTBOX_PENDING_ROWS`.
    The platform-admin wrapper stays in `worker.metrics.ts`, and the gauge now refuses a pool with no
    read.
  - SQL, job names and log component names are unchanged. Both baselines only shrink (22 boundary
    lines; 2 module-cycle edges, 2 renamed). The catalog-family lines wait for RT-1463.
