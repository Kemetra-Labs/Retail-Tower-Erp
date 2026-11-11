-- 0096_erp_stock_import.sql
--
-- RT-1288 (Inventory Gate 8 P4): ERP-origin stock import ingestion.
--
-- [GATED: migration] authorized by the owner on 2026-11-11 (Jira RT-1288
-- comment 16634), with the runtime that lifts the contract-only markers of
-- `erpnext-connector/stock-import.yaml` (RT-1286). Applying this migration to a
-- lab or live database is a separate owner step. Number 0096: 0093 (#508) and
-- 0094 (RT-451 S5, #512) are held by open PRs; 0095 is left for RT-451 S6.
--
-- Source of truth:
--   - `packages/contracts/openapi/erpnext-connector/stock-import.yaml` 1.0.0-draft;
--   - Confluence "Inventory Gate 8" (page 70680596) §3 row (b), DC-4, DC-6, DC-8;
--   - RT-1286 captain decisions D1-D3 (comment 16553).
--
-- What it adds:
--
--   erp_stock_import_runs   one import run per mapped bucket warehouse (the
--                           store's active `stock` warehouse map); status
--                           running -> completed | refused | failed.
--   erp_stock_import_pages  one wanted page of a run (the feed item; its id is
--                           the contract's `requestRef`) and the report
--                           recorded for it.
--   erp_stock_import_rows   every reported row, recorded once per
--                           (warehouse, ledgerEntryRef, entryIndex), with how
--                           Backend-Core classified it (DC-4) and the effect it
--                           wrote. A re-read row (cursor overlap) is recognised
--                           here and never classified twice.
--   erp_stock_import_findings
--                           the visible findings: an unattributed ERP movement,
--                           an unknown item, a UOM mismatch, an unmapped
--                           warehouse (a Connector refusal), and the rows that
--                           cannot be keyed or imported safely.
--
-- And it widens one CHECK on `inventory_effect_integration`: an `external`
-- (ERP-origin) effect carries `erp_confirmed_at` = the Stock Ledger Entry
-- `creation` (RT-1288 scope). Before: only `confirmed` carried it. After:
-- `confirmed` and `external` carry it, every other state does not. No existing
-- row is `external` (nothing wrote that state before RT-1288), so every row
-- already satisfies the new rule.
--
-- RLS: every new table is ENABLE + FORCE ROW LEVEL SECURITY with the
-- `app.current_tenant` policies. Runs and pages also have an UPDATE policy (a
-- run is closed, a page records its report); rows and findings are SELECT and
-- INSERT only (append-only evidence).
--
-- Grants: none here. The domain role's privileges are in
-- `docs/operations/sql/erp-stock-import-domain-grants.sql` (grant fragment
-- `apps/api/src/auth/grants/erp-stock-import.grants.ts`), applied in step 2 of
-- every release.
--
-- §XIV: no personal data. ERPNext voucher, item, batch and warehouse names,
-- quantities and timestamps only. No valuation.
--
-- Deploy: apply 0096 and the grants script before the API that serves the
-- stock-import routes rolls out (migrate is step 1, grants step 2).
--
-- Lock impact: ONE transaction. The four tables are created empty; their FKs
-- take SHARE ROW EXCLUSIVE on tenants, stores, erpnext_warehouse_map,
-- tenant_products, stock_movements and tracking_identities while it commits.
-- The CHECK swap on inventory_effect_integration takes ACCESS EXCLUSIVE only
-- for the DROP and the ADD ... NOT VALID (catalog changes, no scan). The new
-- unique index on erpnext_warehouse_map (one row per store) builds in place.
--
-- Reversal: 0096_erp_stock_import.down.sql REFUSES while any import run exists
-- (its rows are the audit of effects already written), and otherwise drops the
-- four tables and restores the original CHECK.

BEGIN;

-- The composite target of the runs' same-tenant map FK (a small table).
CREATE UNIQUE INDEX IF NOT EXISTS uq_erpnext_warehouse_map_id_tenant
  ON erpnext_warehouse_map (id, tenant_id);

CREATE TABLE IF NOT EXISTS erp_stock_import_runs (
  id                     UUID          PRIMARY KEY,
  tenant_id              UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID          NOT NULL,
  warehouse_map_id       UUID          NOT NULL,
  erpnext_warehouse_ref  TEXT          NOT NULL,
  status                 TEXT          NOT NULL DEFAULT 'running',
  status_reason          TEXT,
  settle_seconds         INTEGER       NOT NULL,
  overlap_seconds        INTEGER       NOT NULL,
  started_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  ended_at               TIMESTAMPTZ,
  CONSTRAINT fk_erp_stock_import_runs_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  -- The map of the run's own tenant: an FK check bypasses row security, so a
  -- plain (id) reference would accept another tenant's map.
  CONSTRAINT fk_erp_stock_import_runs_map_tenant
    FOREIGN KEY (warehouse_map_id, tenant_id) REFERENCES erpnext_warehouse_map (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT erp_stock_import_runs_status_allowed
    CHECK (status IN ('running', 'completed', 'refused', 'failed')),
  CONSTRAINT erp_stock_import_runs_ended
    CHECK ((status = 'running') = (ended_at IS NULL)),
  CONSTRAINT erp_stock_import_runs_status_reason_length
    CHECK (status_reason IS NULL OR char_length(status_reason) BETWEEN 1 AND 200),
  CONSTRAINT erp_stock_import_runs_warehouse_ref_length
    CHECK (char_length(erpnext_warehouse_ref) BETWEEN 1 AND 180),
  CONSTRAINT erp_stock_import_runs_settle_range
    CHECK (settle_seconds BETWEEN 0 AND 3600),
  CONSTRAINT erp_stock_import_runs_overlap_range
    CHECK (overlap_seconds BETWEEN 0 AND 86400)
);

-- At most one running run per warehouse map: two concurrent pulls cannot open two.
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_stock_import_runs_running_map
  ON erp_stock_import_runs (tenant_id, warehouse_map_id) WHERE status = 'running';
-- The warehouse's latest runs (run cadence, cursor).
CREATE INDEX IF NOT EXISTS idx_erp_stock_import_runs_tenant_warehouse_started
  ON erp_stock_import_runs (tenant_id, erpnext_warehouse_ref, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_stock_import_runs_id_tenant
  ON erp_stock_import_runs (id, tenant_id);

CREATE TABLE IF NOT EXISTS erp_stock_import_pages (
  id                     UUID          PRIMARY KEY,
  tenant_id              UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id                 UUID          NOT NULL,
  page_seq               INTEGER       NOT NULL,
  after_key              JSONB,
  max_rows               INTEGER       NOT NULL,
  issued_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- The recorded report (all NULL until it is recorded).
  recorded_at            TIMESTAMPTZ,
  idempotency_key        TEXT,
  body_hash              TEXT,
  read_at                TEXT,
  row_count              INTEGER,
  exhausted              BOOLEAN,
  refused                BOOLEAN,
  read_through           JSONB,
  read_through_creation  TIMESTAMPTZ,
  CONSTRAINT fk_erp_stock_import_pages_run_tenant
    FOREIGN KEY (run_id, tenant_id) REFERENCES erp_stock_import_runs (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT erp_stock_import_pages_page_seq_non_negative CHECK (page_seq >= 0),
  CONSTRAINT erp_stock_import_pages_max_rows_range CHECK (max_rows BETWEEN 1 AND 100),
  CONSTRAINT erp_stock_import_pages_recorded_all
    CHECK ((recorded_at IS NULL) = (idempotency_key IS NULL)
       AND (recorded_at IS NULL) = (body_hash IS NULL)
       AND (recorded_at IS NULL) = (read_at IS NULL)
       AND (recorded_at IS NULL) = (row_count IS NULL)
       AND (recorded_at IS NULL) = (exhausted IS NULL)
       AND (recorded_at IS NULL) = (refused IS NULL)),
  CONSTRAINT erp_stock_import_pages_read_through_pair
    CHECK ((read_through IS NULL) = (read_through_creation IS NULL)),
  CONSTRAINT erp_stock_import_pages_row_count_range
    CHECK (row_count IS NULL OR row_count BETWEEN 0 AND max_rows),
  CONSTRAINT erp_stock_import_pages_idempotency_key_length
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT erp_stock_import_pages_read_at_length
    CHECK (read_at IS NULL OR char_length(read_at) BETWEEN 1 AND 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_stock_import_pages_run_seq
  ON erp_stock_import_pages (tenant_id, run_id, page_seq);
-- The feed: open pages in id (UUIDv7, issue) order.
CREATE INDEX IF NOT EXISTS idx_erp_stock_import_pages_open
  ON erp_stock_import_pages (tenant_id, id) WHERE recorded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_stock_import_pages_id_tenant
  ON erp_stock_import_pages (id, tenant_id);

CREATE TABLE IF NOT EXISTS erp_stock_import_rows (
  id                     UUID          PRIMARY KEY,
  tenant_id              UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID          NOT NULL,
  page_id                UUID          NOT NULL,
  erpnext_warehouse_ref  TEXT          NOT NULL,
  ledger_entry_ref       TEXT          NOT NULL,
  entry_index            INTEGER       NOT NULL,
  voucher_type           TEXT          NOT NULL,
  voucher_no             TEXT          NOT NULL,
  voucher_detail_no      TEXT,
  erpnext_item_ref       TEXT          NOT NULL,
  erpnext_batch_ref      TEXT,
  creation               TIMESTAMPTZ   NOT NULL,
  is_cancelled           BOOLEAN       NOT NULL,
  actual_qty             NUMERIC(21,6) NOT NULL,
  stock_uom              TEXT          NOT NULL,
  outcome                TEXT          NOT NULL,
  effect_key             TEXT,
  tenant_product_ref     UUID,
  tracking_identity_id   UUID,
  effect_id              UUID,
  recorded_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT fk_erp_stock_import_rows_page_tenant
    FOREIGN KEY (page_id, tenant_id) REFERENCES erp_stock_import_pages (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_erp_stock_import_rows_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_erp_stock_import_rows_product_tenant
    FOREIGN KEY (tenant_product_ref, tenant_id) REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_erp_stock_import_rows_effect_tenant
    FOREIGN KEY (effect_id, tenant_id) REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT erp_stock_import_rows_outcome_allowed
    CHECK (outcome IN (
      'imported',           -- an erp_external effect was written (effect_id)
      'covered',            -- created at or before the bucket's anchor snapshot (DC-8)
      'retail_provenance',  -- Retail Tower's own voucher, never imported (899)
      'zero_quantity',      -- moved nothing; no effect
      'awaiting_identity',  -- a batch-tracked product's unknown Batch: RT-453 identity birth
      'finding')),          -- see erp_stock_import_findings
  CONSTRAINT erp_stock_import_rows_imported_effect
    CHECK ((outcome = 'imported') = (effect_id IS NOT NULL)),
  CONSTRAINT erp_stock_import_rows_entry_index_non_negative CHECK (entry_index >= 0),
  CONSTRAINT erp_stock_import_rows_text_lengths
    CHECK (char_length(erpnext_warehouse_ref) BETWEEN 1 AND 180
       AND char_length(ledger_entry_ref) BETWEEN 1 AND 140
       AND char_length(voucher_type) BETWEEN 1 AND 140
       AND char_length(voucher_no) BETWEEN 1 AND 140
       AND (voucher_detail_no IS NULL OR char_length(voucher_detail_no) BETWEEN 1 AND 140)
       AND char_length(erpnext_item_ref) BETWEEN 1 AND 140
       AND (erpnext_batch_ref IS NULL OR char_length(erpnext_batch_ref) BETWEEN 1 AND 140)
       AND char_length(stock_uom) BETWEEN 1 AND 140
       AND (effect_key IS NULL OR char_length(effect_key) BETWEEN 1 AND 2000))
);

-- A ledger row is recorded and classified once, however often it is re-read.
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_stock_import_rows_position
  ON erp_stock_import_rows (tenant_id, erpnext_warehouse_ref, ledger_entry_ref, entry_index);
-- The rows recorded under one effect key (cancellation, duplicate detection).
CREATE INDEX IF NOT EXISTS idx_erp_stock_import_rows_effect_key
  ON erp_stock_import_rows (tenant_id, effect_key) WHERE effect_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erp_stock_import_rows_page
  ON erp_stock_import_rows (tenant_id, page_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_stock_import_rows_id_tenant
  ON erp_stock_import_rows (id, tenant_id);

CREATE TABLE IF NOT EXISTS erp_stock_import_findings (
  id                     UUID          PRIMARY KEY,
  tenant_id              UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID          NOT NULL,
  page_id                UUID          NOT NULL,
  row_id                 UUID,
  erpnext_warehouse_ref  TEXT          NOT NULL,
  kind                   TEXT          NOT NULL,
  detail                 JSONB         NOT NULL DEFAULT '{}'::jsonb,
  recorded_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT fk_erp_stock_import_findings_page_tenant
    FOREIGN KEY (page_id, tenant_id) REFERENCES erp_stock_import_pages (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_erp_stock_import_findings_row_tenant
    FOREIGN KEY (row_id, tenant_id) REFERENCES erp_stock_import_rows (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_erp_stock_import_findings_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT erp_stock_import_findings_kind_allowed
    CHECK (kind IN (
      'unattributed_erp_movement',  -- no Retail provenance and not an ERP-owned family (901)
      'unknown_item',               -- the ERPNext Item maps to no single confirmed product
      'uom_mismatch',               -- stock_uom differs from the product's established unit
      'unmapped_warehouse',         -- the Connector refused: ERPNext has no such warehouse
      'unkeyable_row',              -- no voucherDetailNo: no DC-4 key can be built
      'quantity_precision',         -- more fractional digits than the effect journal keeps
      'duplicate_effect_key',       -- a second row under an existing DC-4 key
      'tracking_mismatch')),        -- the Batch belongs to another product, or a tracked row lacks one
  -- A refusal finding is page-level; every other finding names its row.
  CONSTRAINT erp_stock_import_findings_row_required
    CHECK ((kind = 'unmapped_warehouse') = (row_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_erp_stock_import_findings_tenant_store_recorded
  ON erp_stock_import_findings (tenant_id, store_id, recorded_at);

-- RLS -------------------------------------------------------------------------

ALTER TABLE erp_stock_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_stock_import_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE erp_stock_import_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_stock_import_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE erp_stock_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_stock_import_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE erp_stock_import_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp_stock_import_findings FORCE ROW LEVEL SECURITY;

CREATE POLICY erp_stock_import_runs_tenant_read ON erp_stock_import_runs FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erp_stock_import_runs_tenant_insert ON erp_stock_import_runs FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erp_stock_import_runs_tenant_update ON erp_stock_import_runs FOR UPDATE
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY erp_stock_import_pages_tenant_read ON erp_stock_import_pages FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erp_stock_import_pages_tenant_insert ON erp_stock_import_pages FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erp_stock_import_pages_tenant_update ON erp_stock_import_pages FOR UPDATE
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY erp_stock_import_rows_tenant_read ON erp_stock_import_rows FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erp_stock_import_rows_tenant_insert ON erp_stock_import_rows FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY erp_stock_import_findings_tenant_read ON erp_stock_import_findings FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erp_stock_import_findings_tenant_insert ON erp_stock_import_findings FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

-- inventory_effect_integration: `external` carries erp_confirmed_at ------------

ALTER TABLE inventory_effect_integration
  DROP CONSTRAINT IF EXISTS inventory_effect_integration_confirmed_at;
-- NOT VALID and never validated here (the 0042/0044 convention for a CHECK on a
-- large table): a VALIDATE in this transaction would scan the table while the
-- DROP's ACCESS EXCLUSIVE lock is held. Every existing row already satisfies
-- the new rule (no row is `external`), and new rows are checked.
ALTER TABLE inventory_effect_integration
  ADD CONSTRAINT inventory_effect_integration_confirmed_at
    CHECK ((state IN ('confirmed', 'external')) = (erp_confirmed_at IS NOT NULL)) NOT VALID;

COMMIT;
