### Changed
- RT-1225 (refactor, RT-148 H-2, no behaviour change): `UnknownItemsService.captureItem`
  and `ReconciliationService.reopenUnknownItem` now share the pending-duplicate
  SELECT, the fresh `pending` INSERT, the row mapper and the column list from
  `catalog/unknown-items/unknown-item-rows.ts`. SQL, RLS GUC order, dedup,
  audit, idempotency and the response shape are unchanged.
