### Added
- RT-451 slice S5, Tracking Resolution runtime `[GATED: contract, migration]` (owner
  approval RT-451 comment 16535; RT-50 DC-2, G7-9 row 4; RT-455 OD-1, OD-9):
  `listTrackingResolutionQueue` and `bindTrackingResolution` are served and drop their
  `contract-only` markers (`inventory/inventory.yaml` 1.13.0-draft, wording only). Migration
  0094 adds `tracking_resolutions` and `tracking_resolution_lines` (FORCE RLS, SELECT and
  INSERT only; deploy step `docs/operations/sql/tracking-resolutions-domain-grants.sql`). The
  owner-only, audited bind binds an identity of the line's product to every unresolved line
  of a sale and, in one transaction, sets the sale `tracked`, records an `edge_map_missing`
  finding for an identity with no ERP Batch, writes the sale's effects at the bound
  identities with its `sale_post` intent (or leaves both to the worker for a sale not yet
  processed), writes the void and return restores suppressed before the bind, and re-emits
  once each reversal intent the sale's voids, returns, refunds and credit reversals emitted
  before it, so every one is posted exactly once (RT-451 comment 16556 Q1). Refusals: 404
  (unknown sale or identity, another tenant, outside the store scope, never unresolved, a
  serial identity), 400 (not exactly the unresolved lines, blank note), 409 (another
  product's identity, held now or at `occurredAt`, expired or missing a required expiry,
  already resolved, key reused). The queue lists unresolved and resolved sales newest capture
  first in keyset pages; a store_manager gets only the count of its own stores. Neither is
  gated by the tracked-selling switch (OD-T4). Tracked selling stays off: no tenant can
  switch it on in this build.
