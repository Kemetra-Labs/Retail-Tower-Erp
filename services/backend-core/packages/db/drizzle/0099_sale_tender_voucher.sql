-- 0099_sale_tender_voucher.sql
--
-- Voucher as a sale tender (Jira RT-1114, slice R-4a of RT-1098).
-- [GATED] migration, owner-authorized on RT-1114 (comment 16670, 2026-11-12).
--
-- Source-of-truth decisions:
--   - RT-1098 decision 4 = 4A (comment 16394): a voucher is a TENDER. The sale
--     stays at full price and the voucher pays part of it, so
--     Σ tenders = posTotal (RT-10 D1) still holds exactly.
--   - RT-10 rollout corrections (comments 10409 and 10413): a voucher-tendered
--     sale is never offered on the posting feed without its tenders, and
--     capture accepts voucher tenders only after the Connector side (R-4b,
--     RT-1330) is deployed: the `POS_SALE_VOUCHER_TENDER_ENABLED` deploy flag,
--     default off. This migration only makes such a row representable.
--   - packages/contracts/openapi/pos-sales/sales.yaml 1.23.0-draft and
--     erpnext-connector/posting-feed.yaml 1.12.0-draft (`SaleTender.method`
--     `voucher`, `SaleTender.redemptionId`).
--   - packages/db/drizzle/0092_voucher_redemptions.sql (the redemption a
--     voucher tender references; `voucher_redemptions.id` is V-A's
--     `redemption_id`).
--
-- Changes, in order:
--   1. sale_tenders_method_valid gains `voucher` (cash, card_external, voucher).
--   2. sale_tenders.redemption_id UUID NULL: the redemption that paid this
--      tender. Set on a `voucher` tender and only there
--      (sale_tenders_redemption_voucher_only). NULL on every existing row (no
--      backfill; no existing row is a voucher tender).
--   3. voucher_redemptions_tenant_store_id_uk UNIQUE (tenant_id, store_id, id):
--      the FK target below (id is already unique; the extra columns make the
--      key composite, as voucher_redemption_intents_binding_uk in 0092).
--   4. fk_sale_tenders_redemption_tenant_store: (tenant_id, store_id,
--      redemption_id) -> voucher_redemptions (tenant_id, store_id, id). The
--      redemption is of the SAME tenant AND store as the sale. NULL skips it
--      (MATCH SIMPLE), so cash and card tenders are unaffected.
--   5. uq_sale_tenders_tenant_redemption (tenant_id, redemption_id) WHERE
--      redemption_id IS NOT NULL: one redemption pays at most one tender, in
--      one sale, ever (a redemption cannot be spent twice).
--
-- What the database does NOT check (capture does, RT-1114 acceptance 1): that
-- the redemption is un-reversed, that its applied amount equals the tender's
-- amount, and that the voucher's currency is the sale's. Reversal is a later
-- state change, so no constraint can hold it.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / section XIV), re-reviewed for RT-1114
-- ---------------------------------------------------------------------------
-- A new payment method re-triggers SI-012 (0033). `voucher` is a promotional
-- voucher redeemed at the till (v1 vouchers are promotional only, RT-1098
-- c15291 and c16625). sale_tenders stays BUSINESS-CLASS with a payment-method
-- attribute. redemption_id is an opaque UUID of a redemption row
-- (BUSINESS-CLASS with a monetary attribute, 0092): no voucher code, code
-- hash, intent token, customer or holder reference is stored on the tender,
-- and `reference` stays card_external only. Retention inherits sale_tenders'
-- long-horizon insert-only posture; the FK is ON DELETE RESTRICT, and
-- redemptions are never deleted (0092).
--
-- Lock impact: ONE transaction, lock_timeout 2s. sale_tenders takes ACCESS
-- EXCLUSIVE for the CHECK swap, the nullable ADD COLUMN (metadata-only) and
-- the FK; every CHECK and the FK are added NOT VALID, so no existing row is
-- scanned under that lock (each holds by construction: no row is a voucher and
-- every redemption_id is NULL). The partial unique index builds under SHARE
-- (writes wait, reads do not) over a pilot-sized table. voucher_redemptions
-- takes ACCESS EXCLUSIVE to add its unique key over a table that is empty
-- until the R-3 runtime is used. Grants: none. sale_tenders keeps its
-- table-level SELECT + INSERT (0033), which covers the new column; capture
-- reads voucher_redemptions under its 0092 grants
-- (docs/operations/sql/voucher-redemptions-domain-grants.sql).
--
-- Deploy window: none. Apply before the API that writes redemption_id rolls
-- out (migrate is step 1 of every release). Nothing writes a voucher tender
-- until the deploy flag is turned on, after R-4b is deployed.
--
-- Reversal: 0099_sale_tender_voucher.down.sql REFUSES while any voucher tender
-- is stored.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- =============================================================================
-- 1. method: cash, card_external, voucher
-- =============================================================================

ALTER TABLE sale_tenders DROP CONSTRAINT sale_tenders_method_valid;
ALTER TABLE sale_tenders
  ADD CONSTRAINT sale_tenders_method_valid
    CHECK (method IN ('cash', 'card_external', 'voucher')) NOT VALID;

-- =============================================================================
-- 2. redemption_id: set on a voucher tender, and only there
-- =============================================================================

ALTER TABLE sale_tenders ADD COLUMN redemption_id UUID;

ALTER TABLE sale_tenders
  ADD CONSTRAINT sale_tenders_redemption_voucher_only
    CHECK ((method = 'voucher') = (redemption_id IS NOT NULL)) NOT VALID;

-- =============================================================================
-- 3-4. the redemption is of the sale's own tenant and store
-- =============================================================================

ALTER TABLE voucher_redemptions
  ADD CONSTRAINT voucher_redemptions_tenant_store_id_uk UNIQUE (tenant_id, store_id, id);

ALTER TABLE sale_tenders
  ADD CONSTRAINT fk_sale_tenders_redemption_tenant_store
    FOREIGN KEY (tenant_id, store_id, redemption_id)
    REFERENCES voucher_redemptions (tenant_id, store_id, id) ON DELETE RESTRICT NOT VALID;

-- =============================================================================
-- 5. one redemption pays at most one tender
-- =============================================================================

CREATE UNIQUE INDEX uq_sale_tenders_tenant_redemption
  ON sale_tenders (tenant_id, redemption_id) WHERE redemption_id IS NOT NULL;

COMMIT;
