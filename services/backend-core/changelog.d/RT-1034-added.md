### Added
- RT-1034 `[GATED: migration]`, owner authorization on RT-1034 (comment 18022, 2026-11-21): the Automation V1 PoC,
  a sync-failure email alert. A per-tenant BullMQ sweep (`sync-failure-alert-sweep`, every 5 minutes, OFF unless
  `SYNC_FAILURE_ALERT_ENABLED=true`) reads `erpnext_posting_status = permanently_rejected` and
  `sales.sync_status = failed-needs-repair` (read-only) and sends one deduplicated email per open condition to the
  owner / tenant_admin and to a store_manager whose access covers the store (a `store_access` row, or tenant-wide access), through the existing
  `EmailAdapter` seam (SES stays inert without credentials; no new dependency). Migration 0130 adds
  `sync_failure_alert_windows` and `sync_failure_alert_deliveries` (RLS ENABLE + FORCE); a delivery is claimed under a
  unique key before the provider call, and a condition re-arms only after it clears. Metric
  `sync_failure_alert_total{outcome}`; system-actor audit rows `sync_failure_alert.fired|suppressed|delivered|failed`.
  Deploy step: `docs/operations/sql/sync-failure-alerts-domain-grants.sql`.
