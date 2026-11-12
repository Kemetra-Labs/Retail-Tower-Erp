### Added
- RT-453 `[GATED: migration, contract]`, authorization on Jira RT-453 comment
  16685 and coordinator decisions in comment 16686: Tracking Identities are
  born from ERP evidence only (RT-50 G7-3). The 017 stock run births each
  Batch its Connector tracking master read names (`stock-view.yaml` 1.4) for a
  batch-tracked product whose ERP flags agree; an ERP-origin import row births
  the identity of an unknown Batch of a product that needs no expiry, and an
  expiry-required product's row waits (`awaiting_identity`) and is imported at
  the next report once the identity exists. The lot code is the ERPNext Batch
  name exactly as reported; the edge map comes from the evidence. An expiry
  change in the evidence goes through the governed expiry correction
  (`reasonCode` `erp_evidence`, one Safety Revision step). The operator CLI
  `inventory-effects anchor-identities` takes the per-identity Inventory Anchor
  from each store's batch-wise Bin evidence (G7-12, DC-8); it switches nothing
  on. Once a store has it, the 017 run compares batch-tracked products per
  identity, with the new class `tracking_mismatch` (`reconciliation.yaml`
  1.7.0-draft). `listInventorySafetyFindings` now emits the four
  `tracking_consistency` checks (`inventory.yaml` 1.14.0-draft, wording only),
  and the Q13 preconditions `identity_anchor` and
  `tracking_grain_reconciliation` are confirmed from the server's own data.
  Migration 0102 adds `tracking_identity_births`,
  `erp_stock_import_row_resolutions`, `inventory_identity_anchors` and
  `_lines` (FORCE RLS, append-only), `erp_stock_import_rows.event_type`, and
  the class in the result CHECK; run
  `docs/operations/sql/tracking-identity-birth-domain-grants.sql` in step 2.
