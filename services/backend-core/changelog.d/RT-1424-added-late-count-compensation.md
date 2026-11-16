### Added
- RT-1424 `[GATED: migration, OpenAPI]`, owner delegation in chat 2026-11-16 (Inventory Gate 6, RT-292 G6-5): the governed
  resolution of a late pre-cut event that an ERPNext count already absorbed. `resolveCountLateEvent`
  (`inventory/inventory.yaml` 1.18.0-draft) appends ONE Retail-only `count_correction` effect, the late event's signed
  quantity negated, with the new integration state `erp_absorbed` naming the absorbing ERP document. Owner or tenant_admin,
  a mandatory reason, an audit event in the same transaction. All nine G6-5 conditions A to I are enforced; any failure is a
  typed 409 and writes nothing. No ERP intent, work item or document; never automatic. Migration 0118 adds the state, the
  append-only `count_late_compensations` table (UNIQUE per late event) and the SLE posting stamp on `erp_stock_import_rows`
  (`posting_date`, `posting_time`, written by the existing import). `StockMovement.integrationState` gains `erp_absorbed`,
  acknowledged in `tools/oasdiff/breaking-ignore.txt` as RT-435 did for `erp_neutral`. `CountLateEventFinding` gains
  `compensation`.
