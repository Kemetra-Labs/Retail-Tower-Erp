### Security
- RT-1556 `[GATED]`, owner authorization 2026-11-23: the worker's sync-failure alert sweep
  (RT-1034) now runs on its own least-privilege Postgres role and pool
  (`SYNC_FAILURE_ALERT_DATABASE_URL`) instead of the shared `DATABASE_URL` role, so the sweep holds
  no write grant on `erpnext_posting_status`, `sales` or any reconciliation table, and never
  `DELETE`. No migration: the role is created once per database from the superuser template
  `docs/operations/sql/sync-failure-alert-role.sql` (an owner deploy step; no live role is created
  by this change). The URL is required in production only when `SYNC_FAILURE_ALERT_ENABLED=true`
  (the worker refuses to boot without it); otherwise, and outside production, the sweep borrows
  the domain pool as before. When the URL is set, the worker checks the role at boot in production
  (`verifySyncFailureAlertRole`): same database as `DATABASE_URL`, a different role, non-superuser,
  `NOBYPASSRLS`, exactly the required grants and no role membership. The domain role keeps its
  alert-table grants; revoking them is a follow-up. No change to alert behavior, dedup,
  recipients or the claim-before-send limit.
