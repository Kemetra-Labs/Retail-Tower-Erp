### Added
- RT-1151 `[GATED]`, owner authorization on RT-1151 (D1, D5(a), 2026-11-19): migration
  `0123_price_change_set_items_lines` (RT-282 PR-05), the Price Change Set content tables:
  `price_change_set_items` (the authored items, one row per item per draft version, insert-only)
  and `price_change_set_lines` (the lines validation materializes, with their class and the ids
  they replace; immutable except `new_event_id`, set once at publish as the per-line before/after
  record of spec 042 §10), both FORCE RLS, with
  `docs/operations/sql/price-change-set-content-domain-grants.sql`. No runtime uses the tables
  until RT-1484.
