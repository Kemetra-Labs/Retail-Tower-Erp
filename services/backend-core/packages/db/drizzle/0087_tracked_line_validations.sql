-- 0087_tracked_line_validations.sql
--
-- The Tracked Line Validation record (Jira RT-451 slice S2, migration M1
-- part 2). [GATED] migration, owner-approved on RT-451: comment 16216 ("the
-- `tracked_line_validations` table: FORCE RLS, SELECT and INSERT only,
-- unchanged from 15288"); scope confirmed by the captain decision of comment
-- 16236 (owner delegation, RT-1283 comment 16225). M1 part 1 is 0086.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-sales/tracked-lines.yaml 1.0.0-draft
--       (`posValidateTrackedLine`, "THE VALIDATION RECORD")
--   - packages/db/__tests__/migration/0087-tracked-line-validations.spec.ts
--
-- One new table, `tracked_line_validations`. Every TLV call, accepted or
-- refused, stores one row: the server-side audit of what the till was told
-- (the till's own audit events do not reach Backend-Core). Its `id` is the
-- contract's `validationId`, which a sale line later cites
-- (`CaptureSaleLineTracking.validationId`, RT-451 S3); a refused row's id is
-- never valid on a sale line.
--
--   tenant / store / device    from the credential only (FKs to the same
--                              tenant's store and that store's device)
--   operator_user_id           the envelope's operator, or the verified cashier
--                              of the device path
--   auth_path                  'envelope' | 'device'
--   tenant_product_ref         the product asked for (same-tenant FK)
--   requested_identity_id      the identity as sent: by id, or by
--   requested_code             the scanned code (exactly one of the two), with
--   scanned_expiry_date        the scanned expiry (code only; audit only)
--   resolved_identity_id       the identity the server resolved, NULL when the
--                              check stopped before or found none
--   suggested_identity_id      the FEFO suggestion, NULL when none
--   selection                  scanned | fefo_suggested | operator_selected
--   quantity                   the line quantity (> 0, never a refusal cause)
--   draft_line_ref             the till's own draft line reference
--   outcome / refusal_reason   accepted, or refused with exactly one reason
--   safety_revision            the tenant's Safety Revision at validated_at
--   validated_at               the server clock
--
-- No FK on the three identity columns: a requested id can be unknown, and a
-- resolved identity can be another product's (`wrong_product`); identities
-- are never deleted (0045, ON DELETE RESTRICT everywhere they are cited).
--
-- RLS: ENABLE + FORCE, tenant policies for SELECT and INSERT only. NO UPDATE
-- and NO DELETE policy: a validation record is append-only.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT
-- outside migrations: docs/operations/sql/tracked-line-validations-domain-grants.sql
-- (deploy/README.md step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/grants/).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS. Opaque
-- UUIDs, an operator UUID (an operational actor, not customer PII), a printed
-- lot code, dates, an exact quantity, enumerated codes, a till-local draft
-- line reference (never PII, per the contract), a revision counter and a
-- timestamp. No PII, no money. Records live as long as the sales that cite
-- them (the inventory long-horizon, insert-only posture).
--
-- Deploy window: none. The table is new and only the TLV route writes it,
-- behind the default-off gate `POS_TRACKED_SELLING_ENABLED` AND the tenant
-- switch (0086). Apply 0087 and the grants script before the API that uses it
-- rolls out (migrate is step 1, grants step 2 of every release).
--
-- Lock impact: ONE transaction. The table is created empty. Its FKs take
-- SHARE ROW EXCLUSIVE on tenants, stores, devices and tenant_products while
-- the migration commits; nothing is rewritten. Well under a second.
--
-- Reversal: 0087_tracked_line_validations.down.sql REFUSES while any
-- validation record exists (they are the TLV's audit); otherwise it drops the
-- table.

BEGIN;

CREATE TABLE IF NOT EXISTS tracked_line_validations (
  id                     UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID           NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID           NOT NULL,
  device_id              UUID           NOT NULL,
  operator_user_id       UUID           NOT NULL,
  auth_path              TEXT           NOT NULL,
  tenant_product_ref     UUID           NOT NULL,
  requested_identity_id  UUID,
  requested_code         TEXT,
  scanned_expiry_date    DATE,
  resolved_identity_id   UUID,
  suggested_identity_id  UUID,
  selection              TEXT           NOT NULL,
  quantity               NUMERIC(19,6)  NOT NULL,
  draft_line_ref         TEXT           NOT NULL,
  outcome                TEXT           NOT NULL,
  refusal_reason         TEXT,
  safety_revision        BIGINT         NOT NULL,
  validated_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  CONSTRAINT fk_tracked_line_validations_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_tracked_line_validations_device_store_tenant
    FOREIGN KEY (device_id, tenant_id, store_id) REFERENCES devices (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_tracked_line_validations_product_tenant
    FOREIGN KEY (tenant_product_ref, tenant_id) REFERENCES tenant_products (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT tracked_line_validations_auth_path_allowed
    CHECK (auth_path IN ('envelope', 'device')),
  -- Exactly one of the identity id and the scanned code; a scanned expiry only
  -- with the code (the contract's `TrackedLineIdentityRef`).
  CONSTRAINT tracked_line_validations_requested_identity_one
    CHECK ((requested_identity_id IS NULL) <> (requested_code IS NULL)),
  CONSTRAINT tracked_line_validations_scanned_expiry_with_code
    CHECK (scanned_expiry_date IS NULL OR requested_code IS NOT NULL),
  CONSTRAINT tracked_line_validations_requested_code_shape
    CHECK (requested_code IS NULL OR char_length(requested_code) BETWEEN 1 AND 128),
  CONSTRAINT tracked_line_validations_scanned_expiry_in_range
    CHECK (scanned_expiry_date IS NULL OR scanned_expiry_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  CONSTRAINT tracked_line_validations_selection_allowed
    CHECK (selection IN ('scanned', 'fefo_suggested', 'operator_selected')),
  CONSTRAINT tracked_line_validations_quantity_positive
    CHECK (quantity > 0),
  CONSTRAINT tracked_line_validations_draft_line_ref_length
    CHECK (char_length(draft_line_ref) BETWEEN 1 AND 100),
  CONSTRAINT tracked_line_validations_outcome_allowed
    CHECK (outcome IN ('accepted', 'refused')),
  -- A refusal carries exactly one reason from the closed set; an acceptance none.
  CONSTRAINT tracked_line_validations_refusal_reason
    CHECK ((outcome = 'refused') = (refusal_reason IS NOT NULL)),
  CONSTRAINT tracked_line_validations_refusal_reason_allowed
    CHECK (refusal_reason IS NULL OR refusal_reason IN (
      'not_sellable', 'profile_mismatch', 'unknown_identity', 'wrong_product',
      'recalled', 'held', 'expired')),
  -- An acceptance names the identity it accepted.
  CONSTRAINT tracked_line_validations_accepted_resolved
    CHECK (outcome <> 'accepted' OR resolved_identity_id IS NOT NULL),
  CONSTRAINT tracked_line_validations_safety_revision_non_negative
    CHECK (safety_revision >= 0)
);

-- A device's history, newest first (support and the S3 citation check).
CREATE INDEX IF NOT EXISTS idx_tracked_line_validations_tenant_device_validated
  ON tracked_line_validations (tenant_id, device_id, validated_at);

ALTER TABLE tracked_line_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_line_validations FORCE ROW LEVEL SECURITY;

CREATE POLICY tracked_line_validations_tenant_read ON tracked_line_validations
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT only: a validation record is never changed or removed.
CREATE POLICY tracked_line_validations_tenant_insert ON tracked_line_validations
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
