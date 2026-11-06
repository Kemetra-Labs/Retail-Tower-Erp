### Added
- RT-429 `[GATED]` migrations `0084_shift_closes_tenant_closed_idx` and
  `0085_shift_closes_tenant_store_closed_idx`, owner approval 2026-11-06
  (RT-429 comment 15731; index set ratified, PR and merge authorized, not
  applied to a lab or live database): `idx_shift_closes_tenant_closed ON
  shift_closes (tenant_id, closed_at DESC, shift_id DESC)` and
  `idx_shift_closes_tenant_store_closed ON shift_closes (tenant_id, store_id,
  closed_at DESC, shift_id DESC)`, each built `CONCURRENTLY` in a file of its
  own (as 0064-0065), so the admin shift-close list (RT-383) reads a
  tenant-wide or single-store page, first or cursor, as the first index entries
  instead of sorting every in-scope close. A user scoped to several stores with
  no store filter may still sort (owner-approved). No query or contract change;
  `idx_shift_closes_tenant_store` (0036) is kept. Each down drops only its own
  index.
