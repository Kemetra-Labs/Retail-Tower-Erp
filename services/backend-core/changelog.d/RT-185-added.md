### Added
- RT-185 `[GATED]` migration `0081_erpnext_reconciliation_run_running_idx`, owner
  approval 2026-11-06 (RT-185 comment 15728; PR and merge authorized, never
  applied to a lab or live database by that comment): a partial index
  `idx_erpnext_reconciliation_run_tenant_store_running ON
  erpnext_reconciliation_run (tenant_id, store_id, started_at) WHERE status =
  'running'`, built `CONCURRENTLY` (one statement per file, as 0064-0065 and
  0074), so the scheduled stock-run sweep's per-store "already running?" probe
  (RT-179) reads the few running rows instead of filtering the tenant's whole
  run history on every tick. The migration spec proves, as the app role under
  RLS, that the probe, the RT-688 expiry read and the warehouse-map retirement's
  in-flight read use the index and return the same rows. No behaviour change.
