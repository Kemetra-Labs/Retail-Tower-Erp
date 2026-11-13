-- 0107_credit_reversal_voucher_refund.sql
--
-- RT-1343 item 2 (credit-void mirror) — `[GATED: contract, migration]`.
-- Owner authority: owner decisions in chat 2026-11-12, recorded on RT-1343
-- (comment of 2026-11-13): a full void of a completed voucher-paid sale
-- RESTORES the voucher, and the accepted-break entries for adding `voucher` to
-- the credit-reversal refund tender are approved (needed for this item).
-- Owner authorization to implement and merge on a green `required`: chat
-- 2026-11-13. Applying it to a lab or live database is NOT authorized.
--
-- Source-of-truth artifacts:
--   - packages/contracts/openapi/pos-sales/sales.yaml (`CreditReversalRefundTender`)
--   - packages/db/src/schema/sales/sale-credit-reversals.ts
--   - packages/db/__tests__/migration/0107-credit-reversal-voucher-refund.spec.ts
--
-- A credit `void` mirrors each collected sale tender with one refund tender
-- (RT-577 D8). Since RT-1114 a sale tender may be a `voucher`, so the mirror
-- needs `voucher` too, else a voucher-paid credit sale cannot be voided at all.
-- This widens ONE CHECK: `sale_credit_reversal_tenders_method_valid` gains
-- `voucher`. `sale_credit_reversal_tenders_reference_card_only` is unchanged
-- and already refuses a reference on any method other than `card_external`.
--
-- No backfill (no existing row changes meaning) and no grant change. The new
-- CHECK is a superset of the old one, so every existing row satisfies it;
-- the ALTER holds ACCESS EXCLUSIVE on the table for the validation scan only
-- (one row per credit reversal refund tender: small).

ALTER TABLE sale_credit_reversal_tenders
  DROP CONSTRAINT sale_credit_reversal_tenders_method_valid;

ALTER TABLE sale_credit_reversal_tenders
  ADD CONSTRAINT sale_credit_reversal_tenders_method_valid
  CHECK (method IN ('cash', 'card_external', 'voucher'));
