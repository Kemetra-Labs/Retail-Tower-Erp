-- 0118_count_late_compensation — Jira RT-1424 (RT-292 Inventory Gate 6, G6-5; Confluence page 78938114,
-- conditions A to I). [GATED] migration: the owner's delegation in chat on 2026-11-16 ("i delegate and auhtrize
-- you ... you are delegated for all until mission setteled"; on return "go as we planned to finsish our job by
-- high quakity") is the authorization, recorded in the PR body and on RT-1424.
--
-- A narrow, manually authorized, Retail-only compensation for a late pre-cut event that an ERPNext count has
-- ALREADY absorbed. It never posts to ERP: no intent, work item or document is created.
--
-- Changes (all additive; every existing row stays valid):
--   1. inventory_effect_integration: the state `erp_absorbed`. A Retail effect, created only by the resolution
--      command, whose quantity ERP book already includes through a named, verified ERP document. It carries that
--      document (`erp_document_ref`) and a reason, never an intent (`posting_status_id`) or a confirmation time:
--      the existing intent_link and confirmed_at CHECKs already forbid both for a state outside their lists, and
--      the new `..._erp_absorbed_shape` CHECK requires the document and the reason. `erp_neutral` keeps its
--      meaning (RT-290 Q10); this is a distinct state.
--   2. count_late_compensations: one row per compensated late event. APPEND-ONLY (SELECT and INSERT only).
--      Deterministic deduplication (G): UNIQUE (tenant_id, late_effect_id) means a late event is compensated at
--      most once, UNIQUE (idempotency_key) is the replay key derived from the immutable references.
--   3. erp_stock_import_rows: `posting_date` (DATE) and `posting_time` (TIME), the Stock Ledger Entry's posting
--      stamp as the Connector read it (site-local, preserved as received; stock-import.yaml already carries both).
--      Condition C proves ERP ordering from them, with `creation` as the tie-break (ERPNext orders a warehouse's
--      ledger by posting datetime, then creation). This touches the RT-1288 import path (its INSERT now writes the
--      two columns; no contract change). TIME, not TEXT: ERPNext's `posting_time` IS a time, Postgres TIME holds
--      microseconds exactly as the wire's `HH:MM:SS[.ffffff]` (24-hour, up to 6 fractional digits), it rejects a
--      malformed value by itself (so no format CHECK is needed) and it compares as a time. Rows imported earlier stay
--      NULL, so C refuses on them (fail closed).
--
-- Source-of-truth artifacts:
--   - packages/db/__tests__/migration/0118-count-late-compensation.spec.ts
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / section XIV): BUSINESS-CLASS. Opaque ids, an exact quantity, an ERP
-- document reference, a bounded reason, operator uuids, evidence JSON of ledger facts (names, quantities, stamps).
-- No PII, no money.
--
-- Lock impact: transaction 1 holds ACCESS EXCLUSIVE only for the nullable ADD COLUMNs (metadata) and the
-- constraint swaps; the new CHECKs are NOT VALID there. Transaction 2 validates them (SHARE UPDATE EXCLUSIVE).
-- The new table is created empty. Reversal: 0118_count_late_compensation.down.sql REFUSES while any compensation
-- or `erp_absorbed` effect exists.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE erp_stock_import_rows
  ADD COLUMN IF NOT EXISTS posting_date DATE,
  ADD COLUMN IF NOT EXISTS posting_time TIME;

ALTER TABLE erp_stock_import_rows
  DROP CONSTRAINT IF EXISTS erp_stock_import_rows_posting_stamp_pair;
ALTER TABLE erp_stock_import_rows
  ADD CONSTRAINT erp_stock_import_rows_posting_stamp_pair
    CHECK ((posting_date IS NULL) = (posting_time IS NULL)) NOT VALID;

ALTER TABLE inventory_effect_integration
  DROP CONSTRAINT IF EXISTS inventory_effect_integration_state_allowed,
  DROP CONSTRAINT IF EXISTS inventory_effect_integration_erp_absorbed_shape;
ALTER TABLE inventory_effect_integration
  ADD CONSTRAINT inventory_effect_integration_state_allowed
    CHECK (state IN ('not_posted', 'pending', 'confirmed', 'rejected', 'reconciliation_required',
                     'external', 'erp_neutral', 'erp_absorbed')) NOT VALID,
  ADD CONSTRAINT inventory_effect_integration_erp_absorbed_shape
    CHECK (state <> 'erp_absorbed'
        OR (erp_document_ref IS NOT NULL AND posting_status_id IS NULL AND erp_confirmed_at IS NULL
            AND state_reason IS NOT NULL)) NOT VALID;

CREATE TABLE IF NOT EXISTS count_late_compensations (
  id                    UUID          PRIMARY KEY,
  tenant_id             UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id              UUID          NOT NULL,
  session_id            UUID          NOT NULL,
  tenant_product_ref    UUID          NOT NULL,
  late_effect_id        UUID          NOT NULL,
  count_effect_id       UUID          NOT NULL,
  compensation_effect_id UUID         NOT NULL,
  quantity              NUMERIC(19,4) NOT NULL,
  absorbing_document_ref TEXT         NOT NULL,
  reason                TEXT          NOT NULL,
  approved_by           UUID          NOT NULL,
  idempotency_key       TEXT          NOT NULL,
  evidence              JSONB         NOT NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT fk_count_late_compensations_session
    FOREIGN KEY (session_id, tenant_id, store_id)
    REFERENCES count_sessions (id, tenant_id, store_id) ON DELETE RESTRICT,
  -- The immutable link to the finding (and through it the late event): one finding per (session, effect).
  CONSTRAINT fk_count_late_compensations_finding
    FOREIGN KEY (session_id, late_effect_id)
    REFERENCES count_late_event_findings (session_id, effect_id) ON DELETE RESTRICT,
  CONSTRAINT fk_count_late_compensations_late_effect
    FOREIGN KEY (late_effect_id, tenant_id) REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_count_late_compensations_count_effect
    FOREIGN KEY (count_effect_id, tenant_id) REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_count_late_compensations_effect
    FOREIGN KEY (compensation_effect_id, tenant_id) REFERENCES stock_movements (id, tenant_id) ON DELETE RESTRICT,
  -- G: a late event is compensated at most once, whichever session found it.
  CONSTRAINT uq_count_late_compensations_late_effect UNIQUE (tenant_id, late_effect_id),
  CONSTRAINT uq_count_late_compensations_key UNIQUE (idempotency_key),
  CONSTRAINT uq_count_late_compensations_effect UNIQUE (compensation_effect_id),
  CONSTRAINT count_late_compensations_quantity_nonzero CHECK (quantity <> 0),
  CONSTRAINT count_late_compensations_reason_length CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT count_late_compensations_key_format CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT count_late_compensations_document_length CHECK (char_length(absorbing_document_ref) BETWEEN 1 AND 400),
  CONSTRAINT count_late_compensations_distinct_effects
    CHECK (late_effect_id <> compensation_effect_id AND count_effect_id <> compensation_effect_id)
);

CREATE INDEX IF NOT EXISTS idx_count_late_compensations_session
  ON count_late_compensations (tenant_id, session_id, created_at, id);

ALTER TABLE count_late_compensations ENABLE ROW LEVEL SECURITY;
ALTER TABLE count_late_compensations FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS count_late_compensations_tenant_read ON count_late_compensations;
DROP POLICY IF EXISTS count_late_compensations_tenant_insert ON count_late_compensations;
CREATE POLICY count_late_compensations_tenant_read ON count_late_compensations FOR SELECT
  USING (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                          ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY count_late_compensations_tenant_insert ON count_late_compensations FOR INSERT
  WITH CHECK (tenant_id = CASE WHEN current_setting('app.current_tenant', true) = '' THEN NULL
                               ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;

-- Second transaction: validation (SHARE UPDATE EXCLUSIVE; readers and writers go on). Every existing import row
-- has both stamp columns NULL, and no effect is `erp_absorbed` yet, so validation always passes. A failed
-- validation leaves the constraints NOT VALID and the migration re-runnable (each ADD follows its own DROP).
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE erp_stock_import_rows VALIDATE CONSTRAINT erp_stock_import_rows_posting_stamp_pair;
ALTER TABLE inventory_effect_integration VALIDATE CONSTRAINT inventory_effect_integration_state_allowed;
ALTER TABLE inventory_effect_integration VALIDATE CONSTRAINT inventory_effect_integration_erp_absorbed_shape;

COMMIT;
