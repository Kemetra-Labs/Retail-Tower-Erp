-- 0129_retire_settlement_ledger.down.sql
--
-- Rollback for 0129_retire_settlement_ledger.sql: recreates the six spec-035 A/R
-- ledger tables (receivable, payment_application, claim, claim_receivables,
-- remittance, reconciliation_result) EMPTY, with the 0027 definitions (columns,
-- constraints, indexes, set_updated_at triggers, ENABLE + FORCE RLS and policies).
-- The up migration refuses to drop a non-empty table, so there is no data to restore.
-- payer_account is untouched by both directions. 0027.down is not run here; it still
-- drops these tables, with IF EXISTS, when the whole chain is rolled back.

BEGIN;

-- ---------------------------------------------------------------------------
-- 2. receivable — money owed against a sale by a payer (FR-005/6/7)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receivable (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id      UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  sale_id       UUID         NOT NULL,
  payer_id      UUID         NOT NULL REFERENCES payer_account(id) ON DELETE RESTRICT,
  -- Money owed still outstanding (exact-decimal). Changes only via audited
  -- transitions (FR-007).
  outstanding_balance NUMERIC(19,4) NOT NULL,
  -- CARVE: NO reversal_consumed (deferred to post-DP-026 additive migration).
  state         TEXT         NOT NULL DEFAULT 'open',
  -- 7-C: nullable external ref to the ERPNext accounting Payment Entry
  -- (valuation projection ERPNext owns). NULL until the connector posting gate
  -- (011-DR-POSTING-R1) clears. DP-2 owns the operational record; this is a
  -- non-authoritative pointer.
  erpnext_payment_entry_ref TEXT,
  -- Tax-pending placeholder; NO VAT allocation in v1 (§OQ-2, FR-023).
  tax_placeholder JSONB,
  version       INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT receivable_state_valid
    CHECK (state IN ('open', 'partially_applied', 'settled', 'claimed', 'flagged')),
  CONSTRAINT receivable_balance_non_negative
    CHECK (outstanding_balance >= 0),
  CONSTRAINT receivable_version_non_negative CHECK (version >= 0),
  -- Composite-FK target key: child tables (payment_application, claim_receivables)
  -- reference (id, tenant_id, store_id), so that triple must be UNIQUE — the
  -- uq_sales_id_tenant_store precedent on `sales`. (id is already the PK; this
  -- adds the composite key the FKs match against.)
  CONSTRAINT uq_receivable_id_tenant_store UNIQUE (id, tenant_id, store_id),
  -- Composite FK: a receivable can never reference a sale in a different
  -- tenant/store (the 0012/0026 child-table defense beneath RLS).
  CONSTRAINT fk_receivable_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_receivable_tenant_store_list
  ON receivable (tenant_id, store_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_receivable_payer
  ON receivable (tenant_id, payer_id);
-- Open-receivable acceleration (queue / aging): partial index on non-terminal.
CREATE INDEX IF NOT EXISTS idx_receivable_open
  ON receivable (tenant_id, store_id, id DESC)
  WHERE state IN ('open', 'partially_applied', 'claimed');

CREATE TRIGGER receivable_set_updated_at
  BEFORE UPDATE ON receivable
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. payment_application — DP-2-owned cash application (7-C) (FR-011/12)
-- ---------------------------------------------------------------------------
-- Child of receivable (the contract apply-payment is per-receivable). Append-
-- only ledger of applications; the receivable's outstanding_balance is the
-- running aggregate.
CREATE TABLE IF NOT EXISTS payment_application (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id      UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  receivable_id UUID         NOT NULL,
  applied_amount NUMERIC(19,4) NOT NULL,
  -- Optional human note; redacted in the audit trail (§XIII/XIV).
  note          TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT payment_application_amount_positive CHECK (applied_amount > 0),
  -- Composite FK to receivable within the same tenant/store.
  CONSTRAINT fk_payment_application_receivable
    FOREIGN KEY (receivable_id, tenant_id, store_id)
    REFERENCES receivable (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_payment_application_receivable
  ON payment_application (tenant_id, receivable_id, id DESC);

-- ---------------------------------------------------------------------------
-- 4. claim — receivable(s) submitted to a third-party payer (FR-014)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id      UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  payer_id      UUID         NOT NULL REFERENCES payer_account(id) ON DELETE RESTRICT,
  status        TEXT         NOT NULL DEFAULT 'submitted',
  version       INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT claim_status_valid
    CHECK (status IN ('submitted', 'acknowledged', 'reconciled')),
  CONSTRAINT claim_version_non_negative CHECK (version >= 0),
  -- Composite-FK target key: child tables (claim_receivables, remittance,
  -- reconciliation_result) reference (id, tenant_id, store_id), so that triple
  -- must be UNIQUE (the uq_sales_id_tenant_store precedent).
  CONSTRAINT uq_claim_id_tenant_store UNIQUE (id, tenant_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_tenant_store_list
  ON claim (tenant_id, store_id, id DESC);

CREATE TRIGGER claim_set_updated_at
  BEFORE UPDATE ON claim
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. claim_receivables — claim ↔ receivable join (FR-014)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_receivables (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id      UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  claim_id      UUID         NOT NULL,
  receivable_id UUID         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- A receivable appears at most once per claim.
  CONSTRAINT uq_claim_receivables UNIQUE (claim_id, receivable_id),
  CONSTRAINT fk_claim_receivables_claim
    FOREIGN KEY (claim_id, tenant_id, store_id)
    REFERENCES claim (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_claim_receivables_receivable
    FOREIGN KEY (receivable_id, tenant_id, store_id)
    REFERENCES receivable (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_claim_receivables_claim
  ON claim_receivables (tenant_id, claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_receivables_receivable
  ON claim_receivables (tenant_id, receivable_id);

-- ---------------------------------------------------------------------------
-- 6. remittance — amounts paid by a third-party payer against a claim (FR-014)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS remittance (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id        UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  claim_id        UUID         NOT NULL,
  remitted_amount NUMERIC(19,4) NOT NULL,
  -- Optional payer-side remittance advice reference; opaque.
  remittance_ref  TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT remittance_amount_non_negative CHECK (remitted_amount >= 0),
  CONSTRAINT fk_remittance_claim
    FOREIGN KEY (claim_id, tenant_id, store_id)
    REFERENCES claim (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_remittance_claim
  ON remittance (tenant_id, claim_id, id DESC);

-- ---------------------------------------------------------------------------
-- 7. reconciliation_result — matched/variance outcome of remittance vs claim
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_result (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id        UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  claim_id        UUID         NOT NULL,
  claimed_amount  NUMERIC(19,4) NOT NULL,
  remitted_amount NUMERIC(19,4) NOT NULL,
  -- claimed − remitted; recorded, never hidden (FR-014). May be negative.
  variance        NUMERIC(19,4) NOT NULL,
  outcome         TEXT         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_result_outcome_valid
    CHECK (outcome IN ('settled', 'partial', 'flagged')),
  CONSTRAINT fk_reconciliation_result_claim
    FOREIGN KEY (claim_id, tenant_id, store_id)
    REFERENCES claim (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_result_claim
  ON reconciliation_result (tenant_id, claim_id, id DESC);


-- RLS (as 0027): every table tenant-scoped, ENABLE + FORCE, empty-GUC CASE guard.

-- receivable: SELECT/INSERT/UPDATE
ALTER TABLE receivable ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable FORCE  ROW LEVEL SECURITY;
CREATE POLICY receivable_tenant_select ON receivable
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY receivable_tenant_insert ON receivable
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY receivable_tenant_update ON receivable
  FOR UPDATE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- payment_application: SELECT/INSERT (append-only ledger)
ALTER TABLE payment_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_application FORCE  ROW LEVEL SECURITY;
CREATE POLICY payment_application_tenant_select ON payment_application
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY payment_application_tenant_insert ON payment_application
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- claim: SELECT/INSERT/UPDATE
ALTER TABLE claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim FORCE  ROW LEVEL SECURITY;
CREATE POLICY claim_tenant_select ON claim
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY claim_tenant_insert ON claim
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY claim_tenant_update ON claim
  FOR UPDATE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- claim_receivables: SELECT/INSERT (join, append-only)
ALTER TABLE claim_receivables ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_receivables FORCE  ROW LEVEL SECURITY;
CREATE POLICY claim_receivables_tenant_select ON claim_receivables
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY claim_receivables_tenant_insert ON claim_receivables
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- remittance: SELECT/INSERT (append-only)
ALTER TABLE remittance ENABLE ROW LEVEL SECURITY;
ALTER TABLE remittance FORCE  ROW LEVEL SECURITY;
CREATE POLICY remittance_tenant_select ON remittance
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY remittance_tenant_insert ON remittance
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- reconciliation_result: SELECT/INSERT (append-only)
ALTER TABLE reconciliation_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_result FORCE  ROW LEVEL SECURITY;
CREATE POLICY reconciliation_result_tenant_select ON reconciliation_result
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY reconciliation_result_tenant_insert ON reconciliation_result
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
