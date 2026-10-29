### Added
- RT-808 `[GATED]` migration `0074_audit_events_platform_keyset_idx`, owner
  authorization 2026-10-22 (RT-808 comment 13356; PR + CI only, never applied
  to a lab or live database): a partial index
  `audit_events_platform_time_idx ON audit_events (occurred_at DESC, id DESC)
  WHERE tenant_id IS NULL`, built `CONCURRENTLY` (one statement per file, as
  0064-0065), so `listPlatformAuditEvents` (RT-431) reads a page as the first
  index entries instead of sorting the whole tenant-less bucket. EXPLAIN
  (ANALYZE, BUFFERS) on 400k tenant-less rows (scratch PG 18, RLS on, parallel
  seq scan before; RT-431's PG 16 run measured 58 to 81 ms): first page 222 ms
  to 0.2 ms, cursor page 394 ms to 0.3 ms, no Sort. No query or contract change; the
  tenant list keeps `audit_events_tenant_time_idx`. The down drops only the new
  index.
