### Added
- RT-1061 `[GATED]` (OpenAPI + migration, approved under the owner
  delegation of 2026-11-02): RT-973 slice 1 and RT-977 slice 1 in one
  slice. Migration 0077 adds `sales.sync_status_version` (BIGINT, default 0,
  no table rewrite); the drain, the dead-letter producer and the console
  sale-sync repair each add one in the same UPDATE that sets `sync_status`,
  pinned by a writer-enumeration test. `console-sales` `1.2.0-draft` adds
  `ConsoleSaleItem.syncStatusVersion` and `ConsoleSaleDetail.erpPostingFailure`:
  why a failed ERPNext posting of the sale (or its void's reversal) failed,
  with the stored reason, the RT-332 evidence and a `repairPosting` handle for
  `owner`, `tenant_admin` and a platform-admin session, and the category only
  for `store_manager`. `sale-sync-ops` `SaleSyncStatus.syncStatusVersion` is
  now emitted (still optional). `reconciliation.yaml` `1.6.0-draft` names the
  new reader of the RT-410 reason (same readers). `RolesGuard`'s role
  decision is extracted into one tenant role gate the detail also uses. The
  POS sale-history contract and response are unchanged. Decision records:
  `docs/planning/rt-973-sale-sync-status-ordering.md`,
  `docs/planning/rt-977-sale-posting-failure-reason.md`.
