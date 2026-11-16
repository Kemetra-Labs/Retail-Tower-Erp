-- 0114_count_sessions.sql
--
-- The Count Session domain (Jira RT-1420, RT-292 Inventory Gate 6; contract
-- RT-1419, packages/contracts/openapi/inventory/inventory.yaml 1.15.0-draft;
-- Confluence "Inventory Gate 6", page 78938114). [GATED] migration: owner
-- delegation in chat, 2026-11-16 ("i delegate and auhtrize you ... you are
-- delegated for all until mission setteled"), recorded in the PR body.
--
-- Source-of-truth artifacts:
--   - packages/db/__tests__/migration/0114-count-sessions.spec.ts
--
-- ERP-INDEPENDENT AND DARK: nothing here has an ERP column, intent, work item
-- or posting. Count Sessions stay off for every tenant until the activation
-- slice switches `tenant_inventory_settings.count_sessions_enabled` on.
--
-- Six new tables (all tenant-scoped, ENABLE + FORCE RLS by tenant_id):
--   count_sessions            the session and its state machine (G6-1, decisions
--                             824-833). State and the columns each state needs
--                             are CHECK-enforced, so an illegal state cannot be
--                             written.
--   count_session_lines       one row per product of the scope: the unit, the
--                             expected total frozen at the Count Cut, the line
--                             version (bumped when the reviewed state changes),
--                             the acknowledgement and any refusal (G6-2).
--   count_session_expected    expected quantity frozen at the cut, per position
--                             (location, status). SELECT and INSERT only.
--   count_observations        counted quantity per position. APPEND-ONLY: a
--                             later observation supersedes an earlier one by
--                             `seq`, and every counter is kept (G6-10).
--   count_late_event_findings a late pre-cut event (G6-4); one per (session,
--                             effect). SELECT and INSERT only.
--
-- And on `tenant_inventory_settings` (additive, three booleans and the
-- exception's audit columns):
--   count_sessions_enabled          NOT NULL DEFAULT false (the activation flag)
--   count_self_approval_enabled     NOT NULL DEFAULT false (G6-10 exception)
--   count_self_approval_reason / _changed_at / _changed_by
--
-- Grants: none here. docs/operations/sql/count-sessions-domain-grants.sql
-- (deploy step 2). The auth lookup role (BYPASSRLS) must hold nothing.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / section XIV): BUSINESS-CLASS. UUIDs,
-- operator UUIDs, exact quantities, enumerated codes, bounded notes and
-- timestamps. No PII, no money.
--
-- Lock impact: ONE transaction; the tables are created empty. The settings
-- ALTER takes ACCESS EXCLUSIVE on a one-row-per-tenant table with constant
-- defaults (no rewrite).
--
-- Reversal: 0114_count_sessions.down.sql REFUSES while any session exists.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS count_sessions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id           UUID        NOT NULL,
  state              TEXT        NOT NULL DEFAULT 'open',
  scope_product_ids  UUID[]      NOT NULL,
  note               TEXT,
  opened_by          UUID        NOT NULL,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  cut_at             TIMESTAMPTZ,
  cut_watermark      TEXT,
  cut_taken_by       UUID,
  submitted_by       UUID,
  submitted_at       TIMESTAMPTZ,
  approved_by        UUID,
  approved_at        TIMESTAMPTZ,
  approval_policy    TEXT,
  self_approved      BOOLEAN,
  approval_reason    TEXT,
  cancelled_by       UUID,
  cancelled_at       TIMESTAMPTZ,
  cancel_reason      TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_count_sessions_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_count_sessions_id_tenant_store UNIQUE (id, tenant_id, store_id),
  CONSTRAINT count_sessions_state_allowed
    CHECK (state IN ('open', 'cut_taken', 'submitted', 'approved', 'posting', 'confirmed',
                     'needs_attention', 'closed', 'cancelled')),
  CONSTRAINT count_sessions_scope_size
    CHECK (cardinality(scope_product_ids) BETWEEN 1 AND 500),
  CONSTRAINT count_sessions_note_length
    CHECK (note IS NULL OR char_length(note) <= 500),
  -- The cut is one fact: time, watermark and actor together.
  CONSTRAINT count_sessions_cut_all_or_none
    CHECK ((cut_at IS NULL) = (cut_watermark IS NULL) AND (cut_at IS NULL) = (cut_taken_by IS NULL)),
  CONSTRAINT count_sessions_submit_pair
    CHECK ((submitted_by IS NULL) = (submitted_at IS NULL)),
  CONSTRAINT count_sessions_approval_all_or_none
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)
       AND (approved_by IS NULL) = (approval_policy IS NULL)
       AND (approved_by IS NULL) = (self_approved IS NULL)),
  CONSTRAINT count_sessions_approval_policy_allowed
    CHECK (approval_policy IS NULL OR approval_policy IN ('strict_separation', 'small_merchant_exception')),
  -- Self-approval exists only under the exception, and it carries its reason.
  CONSTRAINT count_sessions_self_approval_policy
    CHECK (self_approved IS NULL
        OR (self_approved = false AND approval_policy = 'strict_separation')
        OR approval_policy = 'small_merchant_exception'),
  CONSTRAINT count_sessions_exception_reason
    CHECK (approval_policy IS DISTINCT FROM 'small_merchant_exception'
        OR (approval_reason IS NOT NULL AND char_length(approval_reason) BETWEEN 1 AND 500)),
  CONSTRAINT count_sessions_cancel_all_or_none
    CHECK ((cancelled_by IS NULL) = (cancelled_at IS NULL)
       AND (cancelled_by IS NULL) = (cancel_reason IS NULL)),
  CONSTRAINT count_sessions_cancel_reason_length
    CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 500),
  -- Each state needs the columns that lead to it.
  CONSTRAINT count_sessions_state_open
    CHECK (state <> 'open' OR (cut_at IS NULL AND submitted_at IS NULL AND approved_at IS NULL AND cancelled_at IS NULL)),
  CONSTRAINT count_sessions_state_cut_taken
    CHECK (state <> 'cut_taken' OR (cut_at IS NOT NULL AND submitted_at IS NULL AND approved_at IS NULL AND cancelled_at IS NULL)),
  CONSTRAINT count_sessions_state_submitted
    CHECK (state <> 'submitted' OR (cut_at IS NOT NULL AND submitted_at IS NOT NULL AND approved_at IS NULL AND cancelled_at IS NULL)),
  CONSTRAINT count_sessions_state_approved_on
    CHECK (state NOT IN ('approved', 'posting', 'confirmed', 'needs_attention', 'closed')
        OR (cut_at IS NOT NULL AND submitted_at IS NOT NULL AND approved_at IS NOT NULL AND cancelled_at IS NULL)),
  CONSTRAINT count_sessions_state_cancelled
    CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- A store's sessions, newest first (list) and its live ones (scope-in-use).
CREATE INDEX IF NOT EXISTS idx_count_sessions_tenant_store_opened
  ON count_sessions (tenant_id, store_id, opened_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS count_session_lines (
  session_id         UUID          NOT NULL,
  tenant_id          UUID          NOT NULL,
  store_id           UUID          NOT NULL,
  tenant_product_ref UUID          NOT NULL,
  stocking_unit      TEXT,
  expected_total     NUMERIC(19,4),
  line_version       INTEGER       NOT NULL DEFAULT 1,
  reset_after_seq    BIGINT        NOT NULL DEFAULT 0,
  acknowledged_by    UUID,
  acknowledged_at    TIMESTAMPTZ,
  acknowledgement_note TEXT,
  acknowledged_version INTEGER,
  refusal_code       TEXT,
  stock_count_id     UUID,
  correction_effect_ids UUID[],
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, tenant_product_ref),
  CONSTRAINT fk_count_session_lines_session
    FOREIGN KEY (session_id, tenant_id, store_id)
    REFERENCES count_sessions (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_count_session_lines_product_tenant
    FOREIGN KEY (tenant_product_ref, tenant_id)
    REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT count_session_lines_version_positive CHECK (line_version >= 1),
  CONSTRAINT count_session_lines_ack_all_or_none
    CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL)
       AND (acknowledged_by IS NULL) = (acknowledged_version IS NULL)),
  CONSTRAINT count_session_lines_ack_note_length
    CHECK (acknowledgement_note IS NULL OR char_length(acknowledgement_note) <= 500),
  CONSTRAINT count_session_lines_refusal_allowed
    CHECK (refusal_code IS NULL OR refusal_code IN
      ('count_up_without_valuation_history', 'count_line_unmapped', 'count_line_uom_mismatch')),
  -- The unit is the product's established unit at the store when it has one;
  -- a product with no stock history takes the unit of its observations.
  CONSTRAINT count_session_lines_unit_shape
    CHECK (stocking_unit IS NULL OR char_length(stocking_unit) BETWEEN 1 AND 32)
);

CREATE TABLE IF NOT EXISTS count_session_expected (
  session_id         UUID          NOT NULL,
  tenant_id          UUID          NOT NULL,
  store_id           UUID          NOT NULL,
  tenant_product_ref UUID          NOT NULL,
  location_id        UUID          NOT NULL,
  inventory_status   TEXT          NOT NULL,
  expected_quantity  NUMERIC(19,4) NOT NULL,
  PRIMARY KEY (session_id, tenant_product_ref, location_id, inventory_status),
  CONSTRAINT fk_count_session_expected_line
    FOREIGN KEY (session_id, tenant_product_ref)
    REFERENCES count_session_lines (session_id, tenant_product_ref) ON DELETE RESTRICT,
  CONSTRAINT fk_count_session_expected_session
    FOREIGN KEY (session_id, tenant_id, store_id)
    REFERENCES count_sessions (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT count_session_expected_status_allowed
    CHECK (inventory_status IN ('sellable', 'return_inspection', 'quality_hold', 'damaged', 'expired', 'recall_hold'))
);

CREATE TABLE IF NOT EXISTS count_observations (
  seq                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id                 UUID          NOT NULL UNIQUE,
  session_id         UUID          NOT NULL,
  tenant_id          UUID          NOT NULL,
  store_id           UUID          NOT NULL,
  tenant_product_ref UUID          NOT NULL,
  location_id        UUID          NOT NULL,
  inventory_status   TEXT          NOT NULL,
  counted_quantity   NUMERIC(19,4) NOT NULL,
  stocking_unit      TEXT          NOT NULL,
  counted_by         UUID          NOT NULL,
  counted_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT fk_count_observations_line
    FOREIGN KEY (session_id, tenant_product_ref)
    REFERENCES count_session_lines (session_id, tenant_product_ref) ON DELETE RESTRICT,
  CONSTRAINT fk_count_observations_session
    FOREIGN KEY (session_id, tenant_id, store_id)
    REFERENCES count_sessions (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_count_observations_location
    FOREIGN KEY (location_id, store_id, tenant_id)
    REFERENCES stock_locations (id, store_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT count_observations_status_allowed
    CHECK (inventory_status IN ('sellable', 'return_inspection', 'quality_hold', 'damaged', 'expired', 'recall_hold')),
  CONSTRAINT count_observations_quantity_non_negative CHECK (counted_quantity >= 0),
  CONSTRAINT count_observations_unit_shape
    CHECK (char_length(stocking_unit) BETWEEN 1 AND 32)
);

CREATE INDEX IF NOT EXISTS idx_count_observations_session_product
  ON count_observations (session_id, tenant_product_ref, seq DESC);

CREATE TABLE IF NOT EXISTS count_late_event_findings (
  id                 UUID          PRIMARY KEY,
  tenant_id          UUID          NOT NULL,
  store_id           UUID          NOT NULL,
  session_id         UUID          NOT NULL,
  tenant_product_ref UUID          NOT NULL,
  assessment         TEXT          NOT NULL,
  quantity           NUMERIC(19,4) NOT NULL,
  event_type         TEXT          NOT NULL,
  event_reference    TEXT          NOT NULL,
  source_system      TEXT          NOT NULL,
  external_id        TEXT          NOT NULL,
  effect_id          UUID          NOT NULL,
  oversell_risk      BOOLEAN       NOT NULL,
  erp_stamp          TIMESTAMPTZ   NOT NULL,
  detected_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  detected_in_state  TEXT          NOT NULL,
  CONSTRAINT fk_count_late_findings_session
    FOREIGN KEY (session_id, tenant_id, store_id)
    REFERENCES count_sessions (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_count_late_findings_effect
    FOREIGN KEY (effect_id) REFERENCES stock_movements (id) ON DELETE RESTRICT,
  CONSTRAINT uq_count_late_findings_session_effect UNIQUE (session_id, effect_id),
  CONSTRAINT count_late_findings_assessment_allowed
    CHECK (assessment IN ('understated', 'overstated')),
  CONSTRAINT count_late_findings_quantity_positive CHECK (quantity > 0),
  CONSTRAINT count_late_findings_state_allowed
    CHECK (detected_in_state IN ('open', 'cut_taken', 'submitted', 'approved', 'posting', 'confirmed',
                                 'needs_attention', 'closed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_count_late_findings_session_detected
  ON count_late_event_findings (session_id, detected_at, id);

-- ---------------------------------------------------------------------------
-- RLS: ENABLE + FORCE, fail-closed by tenant_id (the empty-GUC CASE guard).
-- ---------------------------------------------------------------------------
ALTER TABLE count_sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_sessions            FORCE  ROW LEVEL SECURITY;
ALTER TABLE count_session_lines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_session_lines       FORCE  ROW LEVEL SECURITY;
ALTER TABLE count_session_expected    ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_session_expected    FORCE  ROW LEVEL SECURITY;
ALTER TABLE count_observations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_observations        FORCE  ROW LEVEL SECURITY;
ALTER TABLE count_late_event_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_late_event_findings FORCE  ROW LEVEL SECURITY;

-- Sessions and lines change state: SELECT, INSERT, UPDATE. No DELETE policy.
CREATE POLICY count_sessions_tenant_read ON count_sessions FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_sessions_tenant_insert ON count_sessions FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_sessions_tenant_update ON count_sessions FOR UPDATE
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY count_session_lines_tenant_read ON count_session_lines FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_session_lines_tenant_insert ON count_session_lines FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_session_lines_tenant_update ON count_session_lines FOR UPDATE
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

-- Append-only tables: SELECT and INSERT only.
CREATE POLICY count_session_expected_tenant_read ON count_session_expected FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_session_expected_tenant_insert ON count_session_expected FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY count_observations_tenant_read ON count_observations FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_observations_tenant_insert ON count_observations FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY count_late_findings_tenant_read ON count_late_event_findings FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_late_findings_tenant_insert ON count_late_event_findings FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

-- ---------------------------------------------------------------------------
-- Tenant settings: the activation flag (dark by default) and the G6-10
-- small-merchant exception with its recorded reason.
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_inventory_settings
  ADD COLUMN IF NOT EXISTS count_sessions_enabled         BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS count_self_approval_enabled    BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS count_self_approval_reason     TEXT,
  ADD COLUMN IF NOT EXISTS count_self_approval_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS count_self_approval_changed_by UUID;

ALTER TABLE tenant_inventory_settings
  ADD CONSTRAINT tenant_inventory_settings_count_self_approval_change_pair
    CHECK ((count_self_approval_changed_at IS NULL) = (count_self_approval_changed_by IS NULL)),
  ADD CONSTRAINT tenant_inventory_settings_count_self_approval_reason
    CHECK (NOT count_self_approval_enabled
        OR (count_self_approval_reason IS NOT NULL
            AND char_length(count_self_approval_reason) BETWEEN 1 AND 500
            AND count_self_approval_changed_at IS NOT NULL));

COMMIT;
