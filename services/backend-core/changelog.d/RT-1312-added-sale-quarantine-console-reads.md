### Added
- RT-1312 Phase 3(b), slice B `[GATED: contract]`: the Console list, read and write-off of
  quarantined sales. `consoleListQuarantinedSales`
  (`GET /api/v1/catalog/sale-sync-ops/quarantined-sales`: open items by default, `state`
  selects resolved ones, newest-first keyset paging), `consoleGetQuarantinedSale`
  (`GET .../quarantined-sales/{quarantineRef}`) and `consoleWriteOffQuarantinedSale`
  (`POST .../quarantined-sales/{quarantineRef}/write-off`, `Idempotency-Key` required, a
  required note of 1 to 500 characters) lose their contract-only marker. They use the
  cookie session, are limited to `owner` and `tenant_admin`, are bound to the caller's store
  scope (an item outside it is the same 404 as an absent one) and never return the stored
  body. The write-off closes an `open` item for good without creating a sale; an item that
  is not `open` is 409 `repair_conflict`; the audit row carries ids only, never the note.
  `consoleRepairQuarantinedSale` stays contract-only (slice C) and `POS_CONTRACT_REVISION`
  is unchanged, so no till sends the upload yet. No migration: it uses the 0093 table and its
  existing column grants.
