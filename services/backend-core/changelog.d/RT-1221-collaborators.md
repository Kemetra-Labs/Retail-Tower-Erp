### Changed
- RT-1221 (refactor, PR 2 of 2, no behaviour change): the transfer, count and
  restock-backfill write paths moved out of `apps/api/src/inventory/inventory.service.ts`
  into `StockTransferService`, `StockCountService` and `InventoryBackfill`, and the
  shared write primitives (reference, position and unit checks, the movement insert,
  `not_posted` record, negative-balance signal and outbox emit) into
  `inventory-write.helpers.ts`. `InventoryService` keeps its public methods and
  delegates to them; the module wiring is unchanged. SQL, RLS GUC order, transaction
  boundaries, outbox events, response shapes and stock effects are unchanged, pinned
  by a new characterization spec written and passing before the split.
