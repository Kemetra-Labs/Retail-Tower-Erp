### Added
- RT-1312 Phase 3(b), slice A `[GATED: contract, migration]`: the sale quarantine
  store and the till's upload. Migration 0093 adds `sale_quarantine_items` (FORCE
  RLS, no DELETE policy; unique provenance per tenant; store, uploading device,
  earlier pairing and captured sale pinned to the row's tenant and store; the
  state machine, the till's reason rules and the body purge as CHECKs; the down
  refuses while any item exists), with column-level domain grants
  (`docs/operations/sql/sale-quarantine-items-domain-grants.sql`, deploy step 2).
  `posQuarantineSale` (`POST /api/pos/v1/quarantined-sales`) is implemented and
  loses its contract-only marker: device bearer only, its own per-device bucket
  `posWriteSaleQuarantine` (120 per hour), a 256 kB route body limit read only
  after the device guard passed on the headers, natural idempotency on the
  provenance (201 first upload, 200 same sale facts, 409 `quarantine_conflict`
  for other facts or another store's item). The Console operations stay
  contract-only until the next slices; `POS_CONTRACT_REVISION` is unchanged, so no
  till sends the upload yet.
