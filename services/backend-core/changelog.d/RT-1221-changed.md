### Changed
- RT-1221 (refactor, PR 1 of 2, no behaviour change): the inventory wire/row types,
  movement column constants and row-to-body mappers moved out of
  `apps/api/src/inventory/inventory.service.ts` into `inventory.types.ts` and
  `inventory.mappers.ts`. The service re-exports every name that was public, so no
  importer changes. A pure move: SQL, transactions, outbox and stock effects are
  untouched. PR 2 (transfer / count / backfill collaborators) follows separately.
