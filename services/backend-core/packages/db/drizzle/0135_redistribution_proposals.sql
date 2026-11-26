-- 0135_redistribution_proposals.sql
--
-- RT-1600 (W9 slice A, N3 of the RT-1596 master plan) — `[GATED: migration]`.
-- Owner authority: Jira RT-1600 (Implementation, owner-authorized): the slice A
-- runtime stores each computed redistribution proposal with its read times,
-- exclusions and warnings, and its lines with their review decisions and accept
-- outcomes, in two new tables with RLS ENABLE + FORCE and composite tenant
-- foreign keys. Applying it to a lab or live database is NOT authorized by this
-- file. The contract it serves is RT-1599
-- (packages/contracts/openapi/inventory/redistribution-proposals.yaml).
--
-- Creates TWO tables:
--
--   redistribution_proposals       one row per stored proposal: its state, who
--                                  computed it and when, `expires_at` (24 hours
--                                  later in V1), the rule, limits and buffer
--                                  policy it ran with, every store with its read
--                                  time and exclusion, the objective and the
--                                  warnings. A compute that proposes nothing
--                                  stores nothing.
--   redistribution_proposal_lines  one row per proposed move: product, source and
--                                  destination store, quantity and stocking unit,
--                                  the shadow review decision and the live accept
--                                  outcome (created / reduced / dropped, with the
--                                  created quantity, the W3 draft Transfer and the
--                                  reason).
--
-- States: open, reviewed, partially_accepted (non-terminal) and accepted,
-- rejected, expired, superseded (terminal). A proposal past `expires_at` is
-- REPORTED expired on read (no sweep); a later compute stores `expired` on it
-- instead of `superseded`, so the one-non-terminal-per-tenant index frees.
--
-- Keys:
--   UNIQUE (tenant_id, id)                         composite target for the lines
--   UNIQUE (tenant_id) WHERE state is non-terminal at most ONE live proposal
--   UNIQUE (proposal_id, line_seq)                 line order
--
-- RLS: ENABLE + FORCE, the 0036 CASE-GUC form. SELECT, INSERT and UPDATE are
-- limited to the caller's tenant; no DELETE policy (history is kept).
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS operational advice: ids, exact-decimal quantities, stocking
-- unit codes, enum states, decisions and drop reasons, timestamps, and a
-- free-text reject reason / review note an operator types (at most 500 / 200
-- characters, no PII by design of the Console copy). NO customer data, NO money,
-- NO payload, NO secret. Retained for the life of the tenant.
-- ---------------------------------------------------------------------------
--
-- Reversal: 0135_redistribution_proposals.down.sql drops both tables. Losing
-- them loses only the advice history: a W3 draft Transfer an accept created is a
-- W3 document of its own and stays. Roll back the API first.
--
-- Runtime grants are provisioned outside migrations:
-- docs/operations/sql/redistribution-proposals-domain-grants.sql (step 2 of
-- deploy/README.md), BEFORE the API image that needs it starts.

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS redistribution_proposals (
  id                        UUID          PRIMARY KEY,
  tenant_id                 UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  state                     TEXT          NOT NULL DEFAULT 'open',
  created_by                UUID          NOT NULL,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  expires_at                TIMESTAMPTZ   NOT NULL,
  decided_at                TIMESTAMPTZ,
  superseded_by             UUID,
  reject_reason             TEXT,
  rule_name                 TEXT          NOT NULL,
  rule_version              TEXT          NOT NULL,
  computed_at               TIMESTAMPTZ   NOT NULL,
  limits                    JSONB         NOT NULL,
  buffer                    JSONB         NOT NULL,
  stores                    JSONB         NOT NULL,
  warnings                  JSONB         NOT NULL DEFAULT '[]'::jsonb,
  objective_deficit_before  NUMERIC(19,4) NOT NULL,
  objective_deficit_after   NUMERIC(19,4) NOT NULL,
  objective_store_pairs     INTEGER       NOT NULL,
  objective_lines           INTEGER       NOT NULL,
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT redistribution_proposals_tenant_id_uk UNIQUE (tenant_id, id),
  -- The proposal that superseded this one, in the same tenant. Deferred: the
  -- supersede and the new proposal are written in one transaction.
  CONSTRAINT fk_redistribution_proposals_superseded_by
    FOREIGN KEY (tenant_id, superseded_by) REFERENCES redistribution_proposals (tenant_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT redistribution_proposals_state_allowed
    CHECK (state IN ('open', 'reviewed', 'partially_accepted', 'accepted', 'rejected', 'expired', 'superseded')),
  CONSTRAINT redistribution_proposals_expiry_after_creation CHECK (expires_at > created_at),
  -- decidedAt: when a terminal state other than `expired` was reached.
  CONSTRAINT redistribution_proposals_decided_when_terminal
    CHECK ((decided_at IS NOT NULL) = (state IN ('accepted', 'rejected', 'superseded'))),
  CONSTRAINT redistribution_proposals_reject_reason_when_rejected
    CHECK ((reject_reason IS NOT NULL) = (state = 'rejected')
       AND (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 1 AND 500)),
  CONSTRAINT redistribution_proposals_superseded_by_when_superseded
    CHECK (superseded_by IS NULL OR (state = 'superseded' AND superseded_by <> id)),
  CONSTRAINT redistribution_proposals_rule_lengths
    CHECK (char_length(rule_name) BETWEEN 1 AND 64 AND char_length(rule_version) BETWEEN 1 AND 32),
  CONSTRAINT redistribution_proposals_json_shapes
    CHECK (jsonb_typeof(limits) = 'object' AND jsonb_typeof(buffer) = 'object'
       AND jsonb_typeof(stores) = 'array' AND jsonb_typeof(warnings) = 'array'),
  -- A stored proposal always proposes at least one line. NUMERIC admits 'NaN', which sorts above every number, so
  -- it is excluded explicitly (the 0101 offer-engine precedent).
  CONSTRAINT redistribution_proposals_objective_valid
    CHECK (objective_deficit_before >= 0 AND objective_deficit_after >= 0
       AND objective_deficit_before <> 'NaN'::numeric AND objective_deficit_after <> 'NaN'::numeric
       AND objective_deficit_after <= objective_deficit_before
       AND objective_store_pairs >= 1 AND objective_lines >= objective_store_pairs)
);

-- At most one non-terminal proposal per tenant (every compute supersedes it).
CREATE UNIQUE INDEX IF NOT EXISTS redistribution_proposals_one_live_uidx
  ON redistribution_proposals (tenant_id)
  WHERE state IN ('open', 'reviewed', 'partially_accepted');
-- The list: newest first, keyset (created_at DESC, id DESC).
CREATE INDEX IF NOT EXISTS idx_redistribution_proposals_tenant_created
  ON redistribution_proposals (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS redistribution_proposal_lines (
  id                       UUID          PRIMARY KEY,
  tenant_id                UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  proposal_id              UUID          NOT NULL,
  line_seq                 INTEGER       NOT NULL,
  product_id               UUID          NOT NULL,
  source_store_id          UUID          NOT NULL,
  destination_store_id     UUID          NOT NULL,
  quantity                 NUMERIC(19,4) NOT NULL,
  stocking_unit            TEXT          NOT NULL,
  warnings                 JSONB         NOT NULL DEFAULT '[]'::jsonb,
  review_decision          TEXT,
  review_note              TEXT,
  reviewed_at              TIMESTAMPTZ,
  reviewed_by              UUID,
  accept_outcome           TEXT,
  accept_created_quantity  NUMERIC(19,4),
  accept_transfer_id       UUID,
  accept_reason            TEXT,
  accepted_at              TIMESTAMPTZ,
  accepted_by              UUID,
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT fk_redistribution_proposal_lines_proposal
    FOREIGN KEY (tenant_id, proposal_id) REFERENCES redistribution_proposals (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_redistribution_proposal_lines_source
    FOREIGN KEY (tenant_id, source_store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_redistribution_proposal_lines_destination
    FOREIGN KEY (tenant_id, destination_store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_redistribution_proposal_lines_product
    FOREIGN KEY (product_id, tenant_id) REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_redistribution_proposal_lines_transfer
    FOREIGN KEY (accept_transfer_id, tenant_id) REFERENCES shipment_transfers (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT redistribution_proposal_lines_seq_uk UNIQUE (proposal_id, line_seq),
  CONSTRAINT redistribution_proposal_lines_seq_positive CHECK (line_seq >= 1),
  CONSTRAINT redistribution_proposal_lines_stores_differ CHECK (source_store_id <> destination_store_id),
  CONSTRAINT redistribution_proposal_lines_quantity_positive CHECK (quantity > 0 AND quantity <> 'NaN'::numeric),
  CONSTRAINT redistribution_proposal_lines_unit_length CHECK (char_length(stocking_unit) BETWEEN 1 AND 64),
  CONSTRAINT redistribution_proposal_lines_warnings_array CHECK (jsonb_typeof(warnings) = 'array'),
  -- The shadow review decision: whole or absent; a note only with a decision.
  CONSTRAINT redistribution_proposal_lines_review_allowed
    CHECK (review_decision IS NULL OR review_decision IN ('would_accept', 'would_reject')),
  CONSTRAINT redistribution_proposal_lines_review_whole
    CHECK ((review_decision IS NULL) = (reviewed_at IS NULL)
       AND (review_decision IS NULL) = (reviewed_by IS NULL)
       AND (review_note IS NULL OR (review_decision IS NOT NULL AND char_length(review_note) BETWEEN 1 AND 200))),
  -- The accept outcome: created carries the full quantity and a Transfer; reduced a smaller positive quantity,
  -- a Transfer and a reason; dropped no quantity, no Transfer and a reason.
  CONSTRAINT redistribution_proposal_lines_outcome_allowed
    CHECK (accept_outcome IS NULL OR accept_outcome IN ('created', 'reduced', 'dropped')),
  CONSTRAINT redistribution_proposal_lines_outcome_actor
    CHECK ((accept_outcome IS NULL) = (accepted_at IS NULL) AND (accept_outcome IS NULL) = (accepted_by IS NULL)),
  -- COALESCE(..., false): with accept_outcome NULL the `= 'created'` arms are NULL, not false, and a CHECK
  -- passes on NULL; without it a line with no outcome but a reason (or a quantity) would be accepted.
  CONSTRAINT redistribution_proposal_lines_outcome_shape
    CHECK (COALESCE(
      (accept_outcome IS NULL AND accept_created_quantity IS NULL AND accept_transfer_id IS NULL AND accept_reason IS NULL)
      OR (accept_outcome = 'created' AND accept_created_quantity = quantity
          AND accept_transfer_id IS NOT NULL AND accept_reason IS NULL)
      OR (accept_outcome = 'reduced' AND accept_created_quantity > 0 AND accept_created_quantity < quantity
          AND accept_transfer_id IS NOT NULL AND accept_reason IS NOT NULL)
      OR (accept_outcome = 'dropped' AND accept_created_quantity IS NULL
          AND accept_transfer_id IS NULL AND accept_reason IS NOT NULL),
      false
    )),
  CONSTRAINT redistribution_proposal_lines_reason_length
    CHECK (accept_reason IS NULL OR char_length(accept_reason) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS idx_redistribution_proposal_lines_proposal
  ON redistribution_proposal_lines (tenant_id, proposal_id, line_seq);

ALTER TABLE redistribution_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE redistribution_proposals FORCE  ROW LEVEL SECURITY;
ALTER TABLE redistribution_proposal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE redistribution_proposal_lines FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS redistribution_proposals_tenant_select ON redistribution_proposals;
DROP POLICY IF EXISTS redistribution_proposals_tenant_insert ON redistribution_proposals;
DROP POLICY IF EXISTS redistribution_proposals_tenant_update ON redistribution_proposals;
DROP POLICY IF EXISTS redistribution_proposal_lines_tenant_select ON redistribution_proposal_lines;
DROP POLICY IF EXISTS redistribution_proposal_lines_tenant_insert ON redistribution_proposal_lines;
DROP POLICY IF EXISTS redistribution_proposal_lines_tenant_update ON redistribution_proposal_lines;

CREATE POLICY redistribution_proposals_tenant_select ON redistribution_proposals
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY redistribution_proposals_tenant_insert ON redistribution_proposals
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY redistribution_proposals_tenant_update ON redistribution_proposals
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY redistribution_proposal_lines_tenant_select ON redistribution_proposal_lines
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY redistribution_proposal_lines_tenant_insert ON redistribution_proposal_lines
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY redistribution_proposal_lines_tenant_update ON redistribution_proposal_lines
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
