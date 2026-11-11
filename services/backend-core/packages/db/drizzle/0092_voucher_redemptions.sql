-- 0092_voucher_redemptions.sql
--
-- Voucher redemption data model (Jira RT-1111, slice R-2 of RT-1098; design
-- RT-810, amended by decision 1A: redemption consumes the whole voucher).
-- [GATED] migration, owner-authorized on RT-1098 (comment 16496, 2026-11-11).
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-payments/vouchers.yaml
--     (`posValidateVoucher`, `posRedeemVoucher`, `posReverseVoucher`)
--   - packages/db/drizzle/0091_vouchers.sql (the `vouchers` table)
--   - packages/db/__tests__/migration/0092-voucher-redemptions.spec.ts
--
-- Two new tables:
--
--   voucher_redemption_intents  one row per validate. Validate issues the
--                               short-lived `redemption_intent_token`; only its
--                               HASH (`token_hash`, hashToken of the token; the
--                               hash-only posture of 0024 `code_hash`) is
--                               stored, unique per tenant (the 0091 scope), so a database read
--                               never yields a usable token. The row binds the
--                               token to (tenant, store, voucher,
--                               `payment_attempt_id`, applied and forfeited
--                               amounts) and to the cashier (`operator_user_id`)
--                               and terminal (`device_id`) that validated.
--                               `expires_at` is after `created_at` and at
--                               most 5 minutes after it (the contract's TTL).
--                               The 5 minutes is a HARD database limit on
--                               purpose: changing it later needs a migration.
--                               `consumed_at`, when set, lies within
--                               [created_at, expires_at]; the runtime (R-3) sets the actual value.
--                               Redeem sets `consumed_at` once.
--   voucher_redemptions         one row per redeem; `id` IS the contract's
--                               `redemption_id`. `intent_id` is unique, so an
--                               intent yields at most one redemption. A reverse
--                               sets `reversed_at` and `reversed_by_device_id`
--                               together (the contract records the reversing
--                               device in the audit event). A partial unique
--                               index allows at most ONE un-reversed redemption
--                               per voucher (decision 1A: the voucher is used
--                               once; a reverse frees it, so it can be redeemed
--                               again).
--
-- Money: `applied_amount_minor` is > 0, `forfeited_amount_minor` is >= 0 (zero
-- when the voucher is used in full); both, and their SUM (the voucher's value
-- the runtime derives), are <= 9007199254740991 (2^53 - 1), the largest integer
-- the Drizzle bigint mode "number" holds exactly. The
-- amounts are copied onto the redemption at redeem; the voucher's own value
-- stays on `vouchers.amount_minor`.
--
-- Cross-tenant integrity: composite FKs pin every reference to the row's
-- tenant: (tenant_id, voucher_id) -> vouchers, (tenant_id, store_id) -> stores,
-- (tenant_id, intent_id) -> voucher_redemption_intents, and
-- (device_id, tenant_id, store_id) -> devices (id, tenant_id, store_id), as on
-- tracked_line_validations (0087), so the redeeming device is always one of the
-- row's own store. `reversed_by_device_id` (the device that reversed) is pinned the same
-- way once set: (reversed_by_device_id, tenant_id, store_id) -> devices (a NULL
-- column skips a composite FK, MATCH SIMPLE). Any device of the redemption's
-- store may reverse it (RT-1110 c16417); a reverse from another store is
-- `redemption_branch_mismatch`, and the database refuses it too.
-- Binding: a redemption's (store, voucher, payment attempt, applied and
-- forfeited amounts) must equal its intent's, by one composite FK onto
-- voucher_redemption_intents_binding_uk. `device_id` and `operator_user_id`
-- are left out of it on purpose: the redeeming device or cashier may differ
-- from the validating one within the store. `payment_attempt_id` is the
-- POS's own UUID (contract: POS-generated UUID v4); no table holds payment
-- attempts, so it has no FK. `operator_user_id` has no FK, as on 0087 and 0091
-- (the runtime proves the claim against a live cashier admission).
--
-- RLS: ENABLE + FORCE on both. SELECT, INSERT and UPDATE tenant policies on
-- both (consume and reverse are conditional UPDATEs). NO DELETE policy on
-- either table.
--
-- Grants: none here. Production grants the domain role SELECT and INSERT on
-- both tables, column-level UPDATE on (consumed_at) of the intents and on
-- (reversed_at, reversed_by_device_id) of the redemptions, outside
-- migrations: docs/operations/sql/voucher-redemptions-domain-grants.sql
-- (deploy/README.md step 2). The API refuses to boot without them
-- (DOMAIN_REQUIRED_GRANTS, apps/api/src/auth/grants/).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / section XIV): BUSINESS-CLASS, with a
-- monetary value attribute (the 0091 `vouchers` posture, owner-approved
-- 2026-11-11). Opaque UUIDs, a token HASH (a one-way digest of a short-lived
-- secret; the token is never persisted), integer amounts in minor units, an
-- opaque POS-generated payment-attempt UUID (a correlation id, not a payment
-- instrument: no card, account or tender data), timestamps, and the operator user UUID and terminal (device) UUID that
-- performed the step: operational actors and equipment, not customer PII, the
-- same way 0087 classifies its operator_user_id and device_id. No customer or
-- holder reference of any kind. Retention inherits the 001 long-horizon
-- posture: redemptions are audit facts and are never deleted (a reverse is a
-- state change).
--
-- Deploy window: none. Both tables are new and empty; nothing reads or writes
-- them until the redemption runtime (R-3) ships. Apply 0092 and the grants
-- script before the API that uses them rolls out (migrate is step 1, grants
-- step 2 of every release).
--
-- Lock impact: ONE transaction. Tables are created empty. The FKs take
-- SHARE ROW EXCLUSIVE on `tenants`, `vouchers`, `stores` and `devices` while the
-- migration commits; nothing is rewritten. Well under a second (lock_timeout
-- 2s).
--
-- Reversal: 0092_voucher_redemptions.down.sql REFUSES while any intent or
-- redemption exists; otherwise it drops `voucher_redemptions`, then
-- `voucher_redemption_intents`.

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE TABLE voucher_redemption_intents (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID         NOT NULL,
  voucher_id             UUID         NOT NULL,
  payment_attempt_id     UUID         NOT NULL,
  applied_amount_minor   BIGINT       NOT NULL,
  forfeited_amount_minor BIGINT       NOT NULL,
  token_hash             BYTEA        NOT NULL,
  operator_user_id       UUID         NOT NULL,
  device_id              UUID         NOT NULL,
  expires_at             TIMESTAMPTZ  NOT NULL,
  consumed_at            TIMESTAMPTZ  NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT voucher_redemption_intents_applied_positive
    CHECK (applied_amount_minor > 0 AND applied_amount_minor <= 9007199254740991),
  CONSTRAINT voucher_redemption_intents_forfeited_non_negative
    CHECK (forfeited_amount_minor >= 0 AND forfeited_amount_minor <= 9007199254740991),
  CONSTRAINT voucher_redemption_intents_amount_sum
    CHECK (applied_amount_minor + forfeited_amount_minor <= 9007199254740991),
  -- The contract's intent TTL: after issue, and at most 5 minutes from it.
  CONSTRAINT voucher_redemption_intents_ttl
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  -- An intent is consumed once, while it is live.
  CONSTRAINT voucher_redemption_intents_consumed_window
    CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at <= expires_at)),
  CONSTRAINT fk_voucher_redemption_intents_voucher_tenant
    FOREIGN KEY (tenant_id, voucher_id) REFERENCES vouchers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_voucher_redemption_intents_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_voucher_redemption_intents_device_store_tenant
    FOREIGN KEY (device_id, tenant_id, store_id) REFERENCES devices (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT voucher_redemption_intents_tenant_id_uk UNIQUE (tenant_id, id),
  -- FK target of voucher_redemptions: binds a redemption to what its intent
  -- validated (id is already unique; the extra columns make the key composite).
  CONSTRAINT voucher_redemption_intents_binding_uk UNIQUE (
    tenant_id, id, store_id, voucher_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor),
  -- Redeem looks the token up by its hash, inside the device's tenant.
  CONSTRAINT voucher_redemption_intents_tenant_token_hash_uk UNIQUE (tenant_id, token_hash)
);

-- A voucher's intents (the FK's referencing side).
CREATE INDEX idx_voucher_redemption_intents_tenant_voucher
  ON voucher_redemption_intents (tenant_id, voucher_id);

ALTER TABLE voucher_redemption_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_redemption_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY voucher_redemption_intents_tenant_select ON voucher_redemption_intents
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY voucher_redemption_intents_tenant_insert ON voucher_redemption_intents
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY voucher_redemption_intents_tenant_update ON voucher_redemption_intents
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE TABLE voucher_redemptions (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID         NOT NULL,
  voucher_id             UUID         NOT NULL,
  intent_id              UUID         NOT NULL,
  payment_attempt_id     UUID         NOT NULL,
  applied_amount_minor   BIGINT       NOT NULL,
  forfeited_amount_minor BIGINT       NOT NULL,
  operator_user_id       UUID         NOT NULL,
  device_id              UUID         NOT NULL,
  redeemed_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  reversed_at            TIMESTAMPTZ  NULL,
  reversed_by_device_id  UUID         NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT voucher_redemptions_applied_positive
    CHECK (applied_amount_minor > 0 AND applied_amount_minor <= 9007199254740991),
  CONSTRAINT voucher_redemptions_forfeited_non_negative
    CHECK (forfeited_amount_minor >= 0 AND forfeited_amount_minor <= 9007199254740991),
  CONSTRAINT voucher_redemptions_amount_sum
    CHECK (applied_amount_minor + forfeited_amount_minor <= 9007199254740991),
  -- A reverse never precedes the redeem.
  CONSTRAINT voucher_redemptions_reversed_after_redeemed
    CHECK (reversed_at IS NULL OR reversed_at >= redeemed_at),
  -- The reverse columns are set together, or not at all.
  CONSTRAINT voucher_redemptions_reversed_columns
    CHECK ((reversed_at IS NULL) = (reversed_by_device_id IS NULL)),
  CONSTRAINT fk_voucher_redemptions_voucher_tenant
    FOREIGN KEY (tenant_id, voucher_id) REFERENCES vouchers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_voucher_redemptions_store_tenant
    FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE RESTRICT,
  -- The redemption equals its intent in store, voucher, attempt and amounts.
  CONSTRAINT fk_voucher_redemptions_intent_tenant
    FOREIGN KEY (tenant_id, intent_id, store_id, voucher_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor)
    REFERENCES voucher_redemption_intents (
      tenant_id, id, store_id, voucher_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor) ON DELETE RESTRICT,
  CONSTRAINT fk_voucher_redemptions_device_store_tenant
    FOREIGN KEY (device_id, tenant_id, store_id) REFERENCES devices (id, tenant_id, store_id) ON DELETE RESTRICT,
  -- Skipped while reversed_by_device_id is NULL (MATCH SIMPLE).
  CONSTRAINT fk_voucher_redemptions_reversed_by_device_store_tenant
    FOREIGN KEY (reversed_by_device_id, tenant_id, store_id) REFERENCES devices (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT voucher_redemptions_tenant_id_uk UNIQUE (tenant_id, id),
  -- An intent yields at most one redemption.
  CONSTRAINT voucher_redemptions_tenant_intent_uk UNIQUE (tenant_id, intent_id)
);

-- Decision 1A: a voucher is used once. At most one un-reversed redemption per
-- voucher; a reverse frees it.
CREATE UNIQUE INDEX uq_voucher_redemptions_open_per_voucher
  ON voucher_redemptions (tenant_id, voucher_id) WHERE reversed_at IS NULL;

-- A voucher's redemption history (the FK's referencing side).
CREATE INDEX idx_voucher_redemptions_tenant_voucher
  ON voucher_redemptions (tenant_id, voucher_id);

CREATE TRIGGER voucher_redemptions_set_updated_at BEFORE UPDATE ON voucher_redemptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE voucher_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_redemptions FORCE ROW LEVEL SECURITY;

CREATE POLICY voucher_redemptions_tenant_select ON voucher_redemptions
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY voucher_redemptions_tenant_insert ON voucher_redemptions
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY voucher_redemptions_tenant_update ON voucher_redemptions
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
