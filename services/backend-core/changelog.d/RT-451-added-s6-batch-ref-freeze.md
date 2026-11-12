### Added
- RT-451 slice S6, batch-ref freeze and the row-3 ERP intent hold `[GATED: migration]` (owner
  approval RT-451 comment 16535, RT-1283 comment 16534 item 4; RT-50 G7-9 rows 1 to 3, G7-11;
  `erpnext-connector/posting-feed.yaml` 1.10.0-draft, no contract change). Migration 0095 adds
  `tracking_mode`, `tracking_identity_id`, `erpnext_batch_ref` and `erp_hold_cause` to
  `erpnext_posting_resolution` (nullable, CHECKs validated after commit; no new grant). When a
  posting intent is created, the worker freezes each line's Tracking Profile mode and, for a
  batch line sold from an identity (classified `valid` or `flagged`, or bound by a Tracking
  Resolution), that identity and its ERPNext Batch from the edge map. A reversal copies its
  sale's. An operator re-resolution re-freezes from the edge map as it is then. G7-9 row 3 is
  held, never offered: `expired` (from the capture finding) or `edge_map_missing` (no edge-map
  row at the freeze), as is a `sale_post` with a line capture classified as tracked whose version
  froze no tracking (a reversal mirrors what its sale posted).
  The operator re-resolution now counts the frozen identity, Batch and hold as a change, so
  re-resolving after the edge map is repaired releases an `edge_map_missing` hold; an expired lot
  stays held for the owner (RT-50 B1). The posting feed emits `trackingMode` (`none` / `batch`)
  and `erpnextBatchRef` only while tracked selling is in effect for the tenant (the contract's
  per-tenant flag); otherwise every line is unchanged and an intent with a tracked line is held.
  Switching tracked selling on re-heads those held intents under the feed sequence lock;
  turning the `POS_TRACKED_SELLING_ENABLED` deploy gate off and on again needs the same re-head
  as a deploy step. A batch line captured while tracked selling was off
  keeps today's wire (RT-451 comment 16538 item 3 is still open). Tracked selling stays off: no
  tenant can switch it on in this build.
