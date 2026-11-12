-- 0103_tracking_identity_birth.sql
--
-- RT-453 (RT-50 Gate 7 F6; rules G7-3 and G7-12, owner decision RT-50 comment
-- 11765, Q2 and Q13): Tracking Identity birth from ERP evidence, the
-- per-identity Inventory Anchor, and tracking-grain reconciliation.
--
-- [GATED: migration] authorized on RT-453 comment 16685 (2026-11-12), under the
-- owner's delegation of 2026-11-11; coordinator decisions in comment 16686 (the
-- lot code is the ERPNext Batch name; the `tracking_mismatch` class). Applying
-- it to a lab or live database is a separate owner step. Number 0103
-- (coordinator, 2026-11-12): 0093-0098, 0100 and 0101 are on main, and 0099
-- and 0102 are held by #519.
--
-- Source of truth:
--   - RT-50 comments 11763 / 11764 (G7-2, G7-3, G7-12) and 11765 (approval);
--   - `erpnext-connector/stock-view.yaml` 1.4 `BinEntryTracking` (the tracking
--     master read: Batch name, Item, expiry, disabled, batch-wise book
--     quantity), recorded run-scoped in
--     `erpnext_reconciliation_run.summary.bin_view_report` (RT-919);
--   - `erpnext-connector/stock-import.yaml` (RT-1288): a batch-tracked
--     product's unknown Batch is recorded `awaiting_identity` (0096).
--
-- What it adds:
--
--   tracking_identity_births   one row per born identity: the ERP evidence it
--                              was born from (the tracking master read of a
--                              reconciliation run, or one imported Stock
--                              Ledger row). Retail Tower never invents an
--                              identity (G7-3); this row says where each came
--                              from.
--   erp_stock_import_row_resolutions
--                              the later outcome of an `awaiting_identity`
--                              import row once its Batch has an identity: the
--                              effect it imported, or why not. The 0096 row
--                              record stays append-only; this is its
--                              resolution, at most one per row.
--   inventory_identity_anchors / inventory_identity_anchor_lines
--                              the per-identity Inventory Anchor (DC-8, G7-12)
--                              taken at tracked activation from the store's
--                              ERP-confirmed batch-wise Bin evidence: one
--                              header per (tenant, store, generation), one
--                              line per identity. Metadata, never a movement
--                              (779), like 0063's product anchor.
--
-- It adds one nullable column, `erp_stock_import_rows.event_type` (the DC-4
-- event type a row imports under), so an `awaiting_identity` row can be
-- imported once its identity is born.
--
-- And it widens one CHECK on `erpnext_reconciliation_result`: the class
-- `tracking_mismatch` (RT-428 comment 11774: the tracking grain comes "with
-- the tracking-mismatch class"). Every existing value stays allowed.
--
-- RLS: every new table is ENABLE + FORCE ROW LEVEL SECURITY with SELECT and
-- INSERT tenant policies only: births, resolutions and anchors are records,
-- never changed or removed.
--
-- Grants: none here. The domain role's privileges (these tables, plus INSERT
-- on tracking_identities and erpnext_tracking_map) are in
-- `docs/operations/sql/tracking-identity-birth-domain-grants.sql` (grant
-- fragment `apps/api/src/auth/grants/tracking-identity-birth.grants.ts`),
-- applied in step 2 of every release.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Opaque UUIDs,
-- enumerated sources and outcomes, ERPNext Item / Batch / warehouse names,
-- exact quantities and units, a coverage object of counts and timestamps. No
-- PII, no money, no valuation. Retention follows the identities and stores
-- they name (RESTRICT FKs).
--
-- Deploy window: none. Every table is new and only the new runtime writes it;
-- the CHECK widening admits a superset. Apply 0103 and the grants script
-- before the API and worker that write them roll out.
--
-- Lock impact: ONE transaction for the tables. They are created empty; their
-- FKs take SHARE ROW EXCLUSIVE on tenants, stores, tracking_identities,
-- erp_stock_import_rows, stock_movements, inventory_anchors and
-- erpnext_reconciliation_run while it commits (brief; nothing is scanned).
-- The column add and its NOT VALID CHECK take ACCESS EXCLUSIVE on
-- erp_stock_import_rows briefly (catalog only; VALIDATE after the commit).
-- The CHECK swap takes ACCESS EXCLUSIVE on erpnext_reconciliation_result only
-- for the DROP and the ADD ... NOT VALID (catalog changes); the VALIDATE runs
-- after the commit under SHARE UPDATE EXCLUSIVE (reads and writes continue),
-- the 0066 pattern. lock_timeout 2s: if a lock is not granted in time the
-- migration rolls back and is re-run.
--
-- Reversal: 0103_tracking_identity_birth.down.sql REFUSES while any birth,
-- resolution, identity anchor or `tracking_mismatch` result exists, and
-- otherwise drops the four tables and restores the 0066 CHECK.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- 1. tracking_identity_births ------------------------------------------------

CREATE TABLE IF NOT EXISTS tracking_identity_births (
  id                     UUID          PRIMARY KEY,
  tenant_id              UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tracking_identity_id   UUID          NOT NULL,
  tenant_product_ref     UUID          NOT NULL,
  source                 TEXT          NOT NULL,
  reconciliation_run_id  UUID          REFERENCES erpnext_reconciliation_run(id) ON DELETE RESTRICT,
  import_row_id          UUID,
  erpnext_item_ref       TEXT          NOT NULL,
  erpnext_batch_ref      TEXT          NOT NULL,
  born_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- The identity of the row's own product and tenant.
  CONSTRAINT fk_tracking_identity_births_identity
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_tracking_identity_births_import_row
    FOREIGN KEY (import_row_id, tenant_id) REFERENCES erp_stock_import_rows (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT tracking_identity_births_source_allowed
    CHECK (source IN ('tracking_master', 'stock_import')),
  -- Each source names exactly its own evidence.
  CONSTRAINT tracking_identity_births_evidence
    CHECK ((source = 'tracking_master') = (reconciliation_run_id IS NOT NULL)
       AND (source = 'stock_import') = (import_row_id IS NOT NULL)),
  CONSTRAINT tracking_identity_births_ref_lengths
    CHECK (char_length(erpnext_item_ref) BETWEEN 1 AND 140
       AND char_length(erpnext_batch_ref) BETWEEN 1 AND 140)
);

-- An identity is born once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_identity_births_identity
  ON tracking_identity_births (tracking_identity_id);
CREATE INDEX IF NOT EXISTS idx_tracking_identity_births_tenant_born
  ON tracking_identity_births (tenant_id, born_at);

-- 2. erp_stock_import_row_resolutions ---------------------------------------

CREATE TABLE IF NOT EXISTS erp_stock_import_row_resolutions (
  id                     UUID          PRIMARY KEY,
  tenant_id              UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  row_id                 UUID          NOT NULL,
  tracking_identity_id   UUID          NOT NULL,
  tenant_product_ref     UUID          NOT NULL,
  outcome                TEXT          NOT NULL,
  effect_key             TEXT,
  effect_id              UUID,
  resolved_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT fk_erp_stock_import_row_resolutions_row
    FOREIGN KEY (row_id, tenant_id) REFERENCES erp_stock_import_rows (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_erp_stock_import_row_resolutions_identity
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_erp_stock_import_row_resolutions_effect
    FOREIGN KEY (effect_id, tenant_id) REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT erp_stock_import_row_resolutions_outcome_allowed
    CHECK (outcome IN (
      'imported',   -- the erp_external effect was written (effect_id)
      'covered',    -- by then the store's current anchor snapshot holds it (DC-8)
      'finding')),  -- see erp_stock_import_findings (the row's own finding)
  CONSTRAINT erp_stock_import_row_resolutions_imported_effect
    CHECK ((outcome = 'imported') = (effect_id IS NOT NULL)),
  CONSTRAINT erp_stock_import_row_resolutions_effect_key_length
    CHECK (effect_key IS NULL OR char_length(effect_key) BETWEEN 1 AND 2000)
);

-- The ERP event type an import row would import under (DC-4), so a row that
-- awaited its identity can be imported later: its purpose and correction
-- reference are not kept. NULL on a row recorded before 0103 or with no
-- ERP-owned family. A nullable column with no default: no rewrite.
ALTER TABLE erp_stock_import_rows ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE erp_stock_import_rows
  ADD CONSTRAINT erp_stock_import_rows_event_type_allowed
    CHECK (event_type IS NULL OR event_type IN
      ('erp_procurement_receipt', 'erp_manufacturing', 'erp_opening_stock', 'erp_correction')) NOT VALID;

-- A row is resolved once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_stock_import_row_resolutions_row
  ON erp_stock_import_row_resolutions (row_id);
-- The keys a resolution wrote (cancellation and duplicate detection, as 0096's rows).
CREATE INDEX IF NOT EXISTS idx_erp_stock_import_row_resolutions_effect_key
  ON erp_stock_import_row_resolutions (tenant_id, effect_key) WHERE effect_key IS NOT NULL;
-- The awaiting rows of a Batch (the re-drive's lookup).
CREATE INDEX IF NOT EXISTS idx_erp_stock_import_rows_awaiting_batch
  ON erp_stock_import_rows (tenant_id, erpnext_batch_ref) WHERE outcome = 'awaiting_identity';

-- 3. inventory_identity_anchors / inventory_identity_anchor_lines -----------

CREATE TABLE IF NOT EXISTS inventory_identity_anchors (
  id                     UUID          PRIMARY KEY,
  tenant_id              UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID          NOT NULL,
  generation             INTEGER       NOT NULL,
  -- The store's product anchor in force when this one was taken.
  base_anchor_id         UUID          NOT NULL,
  source_run_id          UUID          NOT NULL REFERENCES erpnext_reconciliation_run(id) ON DELETE RESTRICT,
  snapshot_read_at       TIMESTAMPTZ   NOT NULL,
  snapshot_recorded_at   TIMESTAMPTZ   NOT NULL,
  erpnext_warehouse_ref  TEXT          NOT NULL,
  activated_at           TIMESTAMPTZ   NOT NULL,
  coverage               JSONB         NOT NULL,
  created_by             UUID          NOT NULL,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT fk_inventory_identity_anchors_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_identity_anchors_base_anchor
    FOREIGN KEY (base_anchor_id, tenant_id) REFERENCES inventory_anchors (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_identity_anchors_generation_positive CHECK (generation >= 1),
  CONSTRAINT inventory_identity_anchors_warehouse_ref_length
    CHECK (char_length(erpnext_warehouse_ref) BETWEEN 1 AND 140),
  CONSTRAINT inventory_identity_anchors_coverage_object CHECK (jsonb_typeof(coverage) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_identity_anchors_store_generation
  ON inventory_identity_anchors (tenant_id, store_id, generation);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_identity_anchors_id_tenant
  ON inventory_identity_anchors (id, tenant_id);

CREATE TABLE IF NOT EXISTS inventory_identity_anchor_lines (
  id                     UUID          PRIMARY KEY,
  identity_anchor_id     UUID          NOT NULL,
  tenant_id              UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tracking_identity_id   UUID          NOT NULL,
  tenant_product_ref     UUID          NOT NULL,
  -- Exact batch-wise Bin quantity (the stock-view pattern: 15 integer, 6 decimal digits).
  quantity               NUMERIC(21,6) NOT NULL,
  erp_stock_uom          TEXT          NOT NULL,
  erpnext_batch_ref      TEXT          NOT NULL,
  CONSTRAINT fk_inventory_identity_anchor_lines_anchor
    FOREIGN KEY (identity_anchor_id, tenant_id) REFERENCES inventory_identity_anchors (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_identity_anchor_lines_identity
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_identity_anchor_lines_uom_length
    CHECK (char_length(erp_stock_uom) BETWEEN 1 AND 140),
  CONSTRAINT inventory_identity_anchor_lines_batch_ref_length
    CHECK (char_length(erpnext_batch_ref) BETWEEN 1 AND 140)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_identity_anchor_lines_anchor_identity
  ON inventory_identity_anchor_lines (identity_anchor_id, tracking_identity_id);

-- RLS -----------------------------------------------------------------------

ALTER TABLE tracking_identity_births ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_identity_births FORCE ROW LEVEL SECURITY;
ALTER TABLE erp_stock_import_row_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_stock_import_row_resolutions FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_identity_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_identity_anchors FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_identity_anchor_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_identity_anchor_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tracking_identity_births_tenant_read ON tracking_identity_births FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY tracking_identity_births_tenant_insert ON tracking_identity_births FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY erp_stock_import_row_resolutions_tenant_read ON erp_stock_import_row_resolutions FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erp_stock_import_row_resolutions_tenant_insert ON erp_stock_import_row_resolutions FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY inventory_identity_anchors_tenant_read ON inventory_identity_anchors FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY inventory_identity_anchors_tenant_insert ON inventory_identity_anchors FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY inventory_identity_anchor_lines_tenant_read ON inventory_identity_anchor_lines FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY inventory_identity_anchor_lines_tenant_insert ON inventory_identity_anchor_lines FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

-- 4. erpnext_reconciliation_result: the tracking-mismatch class --------------

ALTER TABLE erpnext_reconciliation_result
  DROP CONSTRAINT erpnext_reconciliation_result_class_valid;

ALTER TABLE erpnext_reconciliation_result
  ADD CONSTRAINT erpnext_reconciliation_result_class_valid
    CHECK (mismatch_class IN (
      'match', 'quantity_divergence', 'unmapped_store', 'unmapped_item',
      'dp2_only', 'erpnext_only', 'negative_balance_flagged',
      'expected_pending_erp', 'expected_pending_retail', 'erp_snapshot_stale',
      'uom_mismatch', 'tracking_mismatch'
    )) NOT VALID;

COMMIT;

ALTER TABLE erpnext_reconciliation_result
  VALIDATE CONSTRAINT erpnext_reconciliation_result_class_valid;
ALTER TABLE erp_stock_import_rows
  VALIDATE CONSTRAINT erp_stock_import_rows_event_type_allowed;
