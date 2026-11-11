-- 0091_vouchers.sql
--
-- Voucher issuance data model (Jira RT-1107, slice I-2 of RT-1098; plan
-- docs/planning/rt-922-voucher-issuance.md section 5.4). [GATED] migration,
-- owner-authorized on RT-1098 (comment 16496, 2026-11-11).
--
-- Source-of-truth artifacts:
--   - docs/planning/rt-922-voucher-issuance.md sections 5.3, 5.4 and 7
--   - packages/contracts/openapi/vouchers-admin.openapi.yaml (`Voucher`,
--     `VoucherIssueRequest`: `note` max 200, `expires_at` may be null)
--   - packages/db/__tests__/migration/0091-vouchers.spec.ts
--
-- Two new tables:
--
--   vouchers                  one row per issued voucher. The code is NEVER
--                             stored: only `code_hash` (hashToken of the
--                             normalised code, plan 5.3), unique per tenant.
--                             `status` is 'active' | 'redeemed' | 'cancelled';
--                             expiry is derived at read time from `expires_at`
--                             and never written back (plan 5.4), so 'expired'
--                             is not a stored status. `expires_at` is NULL for
--                             a voucher that does not expire (the contract
--                             allows null). `batch_id` groups one issue call;
--                             there is no batch table, so it has no FK.
--                             `amount_minor` is in minor units of
--                             `currency_code` (the tenant default currency at
--                             issue). The user ids carry no FK, as on the
--                             sibling tables (operator_user_id on 0087,
--                             created_by on 0078).
--   voucher_eligible_stores   (tenant_id, voucher_id, store_id), PK over all
--                             three. Rows exist only when the voucher has
--                             `applies_to_all_stores = false`; the database
--                             cannot enforce that across tables, so the
--                             runtime (RT-1108) owns it. Two composite FKs pin
--                             both sides to the row's tenant: RLS alone does
--                             not stop a row pointing at another tenant's
--                             voucher or store.
--
-- RLS: ENABLE + FORCE on both. `vouchers`: SELECT, INSERT and UPDATE tenant
-- policies (cancel and, later, redeem are conditional UPDATEs; plan 5.4).
-- `voucher_eligible_stores`: SELECT and INSERT only (append-only). NO DELETE
-- policy on either table.
--
-- The redemption tables (`voucher_redemption_intents`, `voucher_redemptions`)
-- are NOT part of this migration (RT-810 slice 3).
--
-- Grants: none here. Production grants the domain role SELECT, INSERT and
-- UPDATE on `vouchers` and SELECT and INSERT on `voucher_eligible_stores`
-- outside migrations: docs/operations/sql/vouchers-domain-grants.sql
-- (deploy/README.md step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/grants/).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / section XIV): BUSINESS-CLASS, with a
-- monetary value attribute. Opaque UUIDs, a code HASH (a one-way digest of a
-- 16-character secret; the plaintext is never persisted), an integer amount in
-- minor units and an ISO currency code (the same money posture as
-- `sale_tenders` in 0033: amounts are value facts, no card, account or
-- customer data), an enumerated status, timestamps, two actor user UUIDs
-- (operational actors, not customer PII) and a bounded internal `note` (max
-- 200 characters; the contract bars personal data in it). No customer
-- reference of any kind. Retention inherits the 001 long-horizon posture;
-- vouchers are never deleted (a cancel is a status change).
--
-- Deploy window: none. Both tables are new and empty; nothing reads or writes
-- them until the voucher runtime (RT-1108) ships. Apply 0091 and the grants
-- script before the API that uses them rolls out (migrate is step 1, grants
-- step 2 of every release).
--
-- Lock impact: ONE transaction. Tables are created empty. The FKs take
-- SHARE ROW EXCLUSIVE on `tenants` and `stores` while the migration commits;
-- nothing is rewritten. Well under a second (lock_timeout 2s).
--
-- Reversal: 0091_vouchers.down.sql REFUSES while any voucher exists; otherwise
-- it drops `voucher_eligible_stores`, then `vouchers`.

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE TABLE vouchers (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  batch_id              UUID         NOT NULL,
  code_hash             BYTEA        NOT NULL,
  amount_minor          BIGINT       NOT NULL,
  currency_code         CHAR(3)      NOT NULL,
  status                TEXT         NOT NULL DEFAULT 'active',
  -- NULL: the voucher does not expire. Expiry is derived at read time.
  expires_at            TIMESTAMPTZ  NULL,
  applies_to_all_stores BOOLEAN      NOT NULL,
  issued_by_user_id     UUID         NOT NULL,
  cancelled_by_user_id  UUID         NULL,
  cancelled_at          TIMESTAMPTZ  NULL,
  note                  TEXT         NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT vouchers_amount_minor_positive CHECK (amount_minor > 0),
  CONSTRAINT vouchers_currency_code_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT vouchers_status_allowed CHECK (status IN ('active', 'redeemed', 'cancelled')),
  -- The cancel columns are set together, and only for a cancelled voucher.
  CONSTRAINT vouchers_cancelled_columns CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (status = 'cancelled') = (cancelled_by_user_id IS NOT NULL)
  ),
  CONSTRAINT vouchers_note_length CHECK (note IS NULL OR char_length(note) <= 200),
  -- FK target of voucher_eligible_stores (the stores_tenant_id_uk pattern).
  CONSTRAINT vouchers_tenant_id_uk UNIQUE (tenant_id, id),
  CONSTRAINT vouchers_tenant_code_hash_uk UNIQUE (tenant_id, code_hash)
);

-- A batch's vouchers, and the console list (tenant-scoped, by creation).
CREATE INDEX idx_vouchers_tenant_batch ON vouchers (tenant_id, batch_id);
CREATE INDEX idx_vouchers_tenant_created ON vouchers (tenant_id, created_at, id);

CREATE TRIGGER vouchers_set_updated_at BEFORE UPDATE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vouchers FORCE ROW LEVEL SECURITY;

CREATE POLICY vouchers_tenant_select ON vouchers
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY vouchers_tenant_insert ON vouchers
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY vouchers_tenant_update ON vouchers
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE TABLE voucher_eligible_stores (
  tenant_id   UUID  NOT NULL,
  voucher_id  UUID  NOT NULL,
  store_id    UUID  NOT NULL,
  CONSTRAINT voucher_eligible_stores_pkey PRIMARY KEY (tenant_id, voucher_id, store_id),
  CONSTRAINT fk_voucher_eligible_stores_voucher_tenant
    FOREIGN KEY (tenant_id, voucher_id) REFERENCES vouchers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_voucher_eligible_stores_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT
);

-- "Which vouchers list this store" (the PK serves the voucher-first lookup).
CREATE INDEX idx_voucher_eligible_stores_tenant_store
  ON voucher_eligible_stores (tenant_id, store_id);

ALTER TABLE voucher_eligible_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_eligible_stores FORCE ROW LEVEL SECURITY;

CREATE POLICY voucher_eligible_stores_tenant_select ON voucher_eligible_stores
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- INSERT only: the eligible set is fixed at issue.
CREATE POLICY voucher_eligible_stores_tenant_insert ON voucher_eligible_stores
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
