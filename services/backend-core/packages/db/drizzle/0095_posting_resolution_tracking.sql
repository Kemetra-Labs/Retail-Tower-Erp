-- 0095_posting_resolution_tracking.sql
--
-- RT-451 S6: freeze each posting-intent line's tracking with the rest of its
-- ERP resolution (RT-50 G7-9 rows 1 to 3, G7-11; contract
-- `erpnext-connector/posting-feed.yaml` 1.10.0-draft `SaleLine.erpnextBatchRef`
-- / `trackingMode`). [GATED] migration: owner authorization on RT-451 comment
-- 16535 (the S6 migration, "batch ref on erpnext_posting_resolution", and the
-- posting-feed fields), restated in RT-1283 comment 16534 item 4. Applying it
-- to the lab, a live database or any deploy is NOT authorized by those
-- comments. Number 0095: #508 holds 0093 and S5 holds 0094.
--
-- The contract says the ERPNext Batch is read from the Inventory edge map
-- (`erpnext_tracking_map`) and FROZEN when the posting intent is created, with
-- the resolution version (RT-332), never recomputed when the work item is
-- offered. G7-9 row 3 (an exact identity expired at the business date, or
-- with no edge-map row) holds the intent in Backend-Core: it is never offered.
--
-- Changes (all on erpnext_posting_resolution, one row per intent, version and
-- sale line):
--   1. tracking_mode TEXT NULL: the product's Catalog Tracking Profile mode
--      (`tenant_products.tracking_mode`) at intent time, `none` | `batch` |
--      `serial`. NULL only on a row written before 0095 (not frozen).
--   2. tracking_identity_id UUID NULL: the tracking identity the line was
--      sold from (a capture classified `valid` or `flagged`, or a Tracking
--      Resolution binding). Provenance only, no FK (the item_map_id pattern):
--      identities are immutable and the edge map is 1:1 and append-only, so
--      the identity names the edge-map row the ref was read from.
--   3. erpnext_batch_ref TEXT NULL: the ERPNext Batch name from the edge map,
--      1..140 characters (the `ErpnextBatchRef.name` and
--      `erpnext_tracking_map.erpnext_ref` bounds).
--   4. erp_hold_cause TEXT NULL: why the intent is held (row 3), `expired` or
--      `edge_map_missing`. An intent with any such line is never offered.
--   5. CHECK erpnext_posting_resolution_tracking_consistent:
--        - an identity only on a `batch` line;
--        - a Batch ref or a hold cause only with an identity;
--        - an identity with no Batch ref is always held;
--        - `edge_map_missing` only without a Batch ref.
-- The CHECKs are added NOT VALID and validated after COMMIT. Every existing
-- row has the new columns NULL, so validation cannot fail.
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): BUSINESS-CLASS. A profile mode, an
-- opaque identity id, an opaque ERPNext Batch name and a closed cause. No PII,
-- no money. The Batch name is the edge map's (0045 classification), which is
-- ERP evidence, never the printed lot code.
--
-- Grants: none. The table's existing SELECT + INSERT grants cover the new
-- columns. The domain role already reads `erpnext_tracking_map`,
-- `sale_line_findings` (0089) and `tracking_resolution_lines` (0094), which
-- the freeze joins.
-- Lock impact: ACCESS EXCLUSIVE on erpnext_posting_resolution for the four
-- nullable ADD COLUMNs with no default (catalog-only) and the NOT VALID
-- CHECKs (no scan); it commits at once. Each VALIDATE then scans the table
-- under SHARE UPDATE EXCLUSIVE, which does not block reads or writes (the
-- posting feed and the worker's freeze keep running).
-- Reversible via 0095_posting_resolution_tracking.down.sql, which refuses
-- while a tracked line is frozen.
BEGIN;
ALTER TABLE erpnext_posting_resolution
  ADD COLUMN tracking_mode TEXT,
  ADD COLUMN tracking_identity_id UUID,
  ADD COLUMN erpnext_batch_ref TEXT,
  ADD COLUMN erp_hold_cause TEXT;
ALTER TABLE erpnext_posting_resolution
  ADD CONSTRAINT erpnext_posting_resolution_tracking_mode_valid
    CHECK (tracking_mode IS NULL OR tracking_mode IN ('none', 'batch', 'serial')) NOT VALID,
  ADD CONSTRAINT erpnext_posting_resolution_batch_ref_length
    CHECK (erpnext_batch_ref IS NULL OR char_length(erpnext_batch_ref) BETWEEN 1 AND 140) NOT VALID,
  ADD CONSTRAINT erpnext_posting_resolution_hold_cause_valid
    CHECK (erp_hold_cause IS NULL OR erp_hold_cause IN ('expired', 'edge_map_missing')) NOT VALID,
  ADD CONSTRAINT erpnext_posting_resolution_tracking_consistent
    CHECK (
      (tracking_identity_id IS NULL OR tracking_mode = 'batch')
      AND (erpnext_batch_ref IS NULL OR tracking_identity_id IS NOT NULL)
      AND (erp_hold_cause IS NULL OR tracking_identity_id IS NOT NULL)
      AND (tracking_identity_id IS NULL OR erpnext_batch_ref IS NOT NULL OR erp_hold_cause IS NOT NULL)
      AND (erp_hold_cause IS DISTINCT FROM 'edge_map_missing' OR erpnext_batch_ref IS NULL)
    ) NOT VALID;
COMMIT;
ALTER TABLE erpnext_posting_resolution
  VALIDATE CONSTRAINT erpnext_posting_resolution_tracking_mode_valid;
ALTER TABLE erpnext_posting_resolution
  VALIDATE CONSTRAINT erpnext_posting_resolution_batch_ref_length;
ALTER TABLE erpnext_posting_resolution
  VALIDATE CONSTRAINT erpnext_posting_resolution_hold_cause_valid;
ALTER TABLE erpnext_posting_resolution
  VALIDATE CONSTRAINT erpnext_posting_resolution_tracking_consistent;
