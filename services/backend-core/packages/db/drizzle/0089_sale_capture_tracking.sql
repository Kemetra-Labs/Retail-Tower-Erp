-- 0089_sale_capture_tracking.sql
--
-- Capture tracking (Jira RT-451 slice S3, migration M2). [GATED] migration,
-- approved by the captain decision of RT-451 comment 16262 (owner delegation,
-- RT-1283 comment 16225), with the content of comment 15288's S3 row:
-- sale-line tracking columns, `sales.safety_revision` and the sale's tracking
-- status, and the `sale_line_findings` table. 0088 is held by an open PR
-- (RT-1292), so this takes 0089.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-sales/sales.yaml (`captureSale`, the G7-9
--       classification; `CaptureSaleLineTracking`, `SaleLineTracking`,
--       `CaptureSaleRequest.safetyRevision` / `safetySyncedAt`)
--   - packages/contracts/openapi/inventory/inventory.yaml
--       (`listSaleLineFindings`, `SaleLineFinding`)
--   - packages/db/__tests__/migration/0089-sale-capture-tracking.spec.ts
--
-- 1. `sale_lines` — the tracking snapshot a line was captured with, frozen
--    like every other line field (the table stays INSERT-only):
--      tracking_identity_id / _code / _expiry_date / _selection /
--      _validation_id   the till's `tracking`, as sent (no FK: an unknown or
--                       another product's identity is accepted and classified)
--      tracking_class   the G7-9 row while tracked selling was on: 'valid'
--                       (row 1), 'flagged' (rows 2 and 3, with sale-line
--                       findings) or 'unresolved' (row 4); NULL for a line
--                       that was not classified (tracked selling off — its
--                       tracking, if sent, is stored as provenance only,
--                       comment 16269 — or an untracked product's line
--                       without tracking)
--      tracking_unresolved_reason  row 4 only: tracking_missing |
--                       identity_unknown | identity_other_product
-- 2. `sales` — the till's safety provenance and the sale's tracking status:
--      safety_revision / safety_synced_at  as the till sent them (RT-50 G7-7;
--                       not part of the payload hash), NULL when absent
--      tracking_status  'tracked' (every classified line resolved) or
--                       'tracking_unresolved' (at least one row-4 line); NULL
--                       when no line was classified
-- 3. `sale_line_findings` — the append-only critical findings of G7-9 rows 2
--    and 3, one per (line, kind, cause). FORCE RLS, SELECT and INSERT only.
--
-- The new columns are nullable with no default, so existing rows read as
-- "captured before RT-451 S3" and nothing is backfilled. Their CHECKs are
-- added NOT VALID: no existing row is scanned, every existing row has the
-- columns NULL (which satisfies each CHECK), and every new row is checked.
--
-- Comment 16269 revises 16262 item 1: while tracked selling is off, tracking
-- is accepted and stored unclassified, so a snapshot may have no class.
--
-- RLS: `sales` and `sale_lines` keep their 0012 policies. The new table is
-- ENABLE + FORCE with tenant policies for SELECT and INSERT only: a finding is
-- a record of a past sale and is never changed or removed.
--
-- Grants: `sales` and `sale_lines` are granted at table level (baseline), so
-- the new columns need nothing. The new table gets SELECT and INSERT for the
-- domain role outside migrations:
-- docs/operations/sql/sale-line-findings-domain-grants.sql (deploy/README.md
-- step 2). The API refuses to boot without them (DOMAIN_REQUIRED_GRANTS).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Opaque UUIDs,
-- a printed lot code, dates, enumerated codes, a revision counter and
-- timestamps. No PII, no money.
--
-- Deploy window: none. Only the capture path writes these columns and only
-- while tracked selling is on (the default-off gate `POS_TRACKED_SELLING_ENABLED`
-- AND the tenant switch of 0086); `safety_revision` / `safety_synced_at` are
-- written whenever a till sends them, which no shipped till does yet.
--
-- Lock impact: ONE transaction. `sales` and `sale_lines` take ACCESS EXCLUSIVE
-- for the nullable ADD COLUMNs (catalog-only, no rewrite) and the NOT VALID
-- CHECKs (no scan); captures wait for the commit. `sale_line_findings` is
-- created empty; its FKs take SHARE ROW EXCLUSIVE on the referenced tables.
-- Well under a second.
--
-- Reversal: 0089_sale_capture_tracking.down.sql REFUSES while any tracked sale
-- data exists (a finding, a line's tracking or a sale's safety provenance or
-- tracking status); otherwise it drops the table and the columns.

BEGIN;

-- =============================================================================
-- 1. sale_lines: the frozen tracking snapshot and its classification
-- =============================================================================

ALTER TABLE sale_lines
  ADD COLUMN IF NOT EXISTS tracking_identity_id        UUID,
  ADD COLUMN IF NOT EXISTS tracking_code               TEXT,
  ADD COLUMN IF NOT EXISTS tracking_expiry_date        DATE,
  ADD COLUMN IF NOT EXISTS tracking_selection          TEXT,
  ADD COLUMN IF NOT EXISTS tracking_validation_id      UUID,
  ADD COLUMN IF NOT EXISTS tracking_class              TEXT,
  ADD COLUMN IF NOT EXISTS tracking_unresolved_reason  TEXT;

ALTER TABLE sale_lines
  -- The snapshot is whole or absent: identity, code and selection together
  -- (the contract's required trio); expiry and validation only with them.
  ADD CONSTRAINT sale_lines_tracking_snapshot_whole
    CHECK ((tracking_identity_id IS NULL) = (tracking_code IS NULL)
       AND (tracking_identity_id IS NULL) = (tracking_selection IS NULL)
       AND (tracking_identity_id IS NOT NULL
            OR (tracking_expiry_date IS NULL AND tracking_validation_id IS NULL))) NOT VALID,
  ADD CONSTRAINT sale_lines_tracking_code_shape
    CHECK (tracking_code IS NULL OR char_length(tracking_code) BETWEEN 1 AND 128) NOT VALID,
  ADD CONSTRAINT sale_lines_tracking_expiry_in_range
    CHECK (tracking_expiry_date IS NULL
        OR tracking_expiry_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') NOT VALID,
  ADD CONSTRAINT sale_lines_tracking_selection_allowed
    CHECK (tracking_selection IS NULL
        OR tracking_selection IN ('scanned', 'fefo_suggested', 'operator_selected')) NOT VALID,
  ADD CONSTRAINT sale_lines_tracking_class_allowed
    CHECK (tracking_class IS NULL OR tracking_class IN ('valid', 'flagged', 'unresolved')) NOT VALID,
  ADD CONSTRAINT sale_lines_tracking_unresolved_reason_allowed
    CHECK (tracking_unresolved_reason IS NULL
        OR tracking_unresolved_reason IN ('tracking_missing', 'identity_unknown', 'identity_other_product')) NOT VALID,
  -- A reason exactly on a row-4 line.
  ADD CONSTRAINT sale_lines_tracking_unresolved_reason_iff
    CHECK ((tracking_unresolved_reason IS NOT NULL) = (tracking_class IS NOT DISTINCT FROM 'unresolved')) NOT VALID,
  -- Only `tracking_missing` has no snapshot among classified lines. A
  -- snapshot without a class is tracking stored while off (comment 16269).
  ADD CONSTRAINT sale_lines_tracking_missing_has_no_snapshot
    CHECK ((tracking_unresolved_reason IS NOT DISTINCT FROM 'tracking_missing')
         = (tracking_class IS NOT NULL AND tracking_identity_id IS NULL)) NOT VALID;

-- =============================================================================
-- 2. sales: the till's safety provenance and the tracking status
-- =============================================================================

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS safety_revision   BIGINT,
  ADD COLUMN IF NOT EXISTS safety_synced_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tracking_status   TEXT;

ALTER TABLE sales
  ADD CONSTRAINT sales_safety_revision_non_negative
    CHECK (safety_revision IS NULL OR safety_revision >= 0) NOT VALID,
  ADD CONSTRAINT sales_tracking_status_allowed
    CHECK (tracking_status IS NULL OR tracking_status IN ('tracked', 'tracking_unresolved')) NOT VALID;

-- =============================================================================
-- 3. sale_line_findings (G7-9 rows 2 and 3; RT-455 OD-2)
-- =============================================================================

CREATE TABLE IF NOT EXISTS sale_line_findings (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id              UUID         NOT NULL,
  sale_id               UUID         NOT NULL,
  sale_line_id          UUID         NOT NULL REFERENCES sale_lines(id) ON DELETE RESTRICT,
  tenant_product_ref    UUID         NOT NULL,
  tracking_identity_id  UUID         NOT NULL,
  kind                  TEXT         NOT NULL,
  cause                 TEXT         NOT NULL,
  hold_id               UUID,
  business_date         DATE         NOT NULL,
  occurred_at           TIMESTAMPTZ  NOT NULL,
  recorded_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- The sale of the same tenant and store.
  CONSTRAINT fk_sale_line_findings_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id) REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT,
  -- Rows 2 and 3 always carry an exact identity of the line's own product.
  CONSTRAINT fk_sale_line_findings_identity_product_tenant
    FOREIGN KEY (tracking_identity_id, tenant_product_ref, tenant_id)
    REFERENCES tracking_identities (id, tenant_product_ref, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sale_line_findings_hold_tenant
    FOREIGN KEY (hold_id, tenant_id) REFERENCES tracking_holds (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sale_line_findings_kind_allowed
    CHECK (kind IN ('unvalidated_tracked_line', 'sold_under_hold', 'erp_intent_held')),
  -- Each kind has its own causes (the contract's `cause`).
  CONSTRAINT sale_line_findings_kind_cause
    CHECK ((kind = 'unvalidated_tracked_line' AND cause IN ('validation_missing', 'validation_mismatch'))
        OR (kind = 'sold_under_hold' AND cause IN ('quality_hold', 'recall_hold'))
        OR (kind = 'erp_intent_held' AND cause IN ('expired', 'edge_map_missing'))),
  -- The hold the line was sold under, only for `sold_under_hold`.
  CONSTRAINT sale_line_findings_hold_iff_sold_under_hold
    CHECK ((kind = 'sold_under_hold') = (hold_id IS NOT NULL))
);

-- One finding per (line, kind, cause): a re-classification writes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_line_findings_line_kind_cause
  ON sale_line_findings (sale_line_id, kind, cause);

-- The list order (`recordedAt DESC, id DESC`), tenant-wide and per store.
CREATE INDEX IF NOT EXISTS idx_sale_line_findings_tenant_recorded
  ON sale_line_findings (tenant_id, recorded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sale_line_findings_tenant_store_recorded
  ON sale_line_findings (tenant_id, store_id, recorded_at DESC, id DESC);

ALTER TABLE sale_line_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_line_findings FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_line_findings_tenant_read ON sale_line_findings
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only: a finding is never changed or removed.
CREATE POLICY sale_line_findings_tenant_insert ON sale_line_findings
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
