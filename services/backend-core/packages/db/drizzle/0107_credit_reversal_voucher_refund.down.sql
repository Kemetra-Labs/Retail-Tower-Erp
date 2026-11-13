-- 0107_credit_reversal_voucher_refund.down.sql - reverses
-- 0107_credit_reversal_voucher_refund.sql (RT-1343 item 2).
--
-- Restores the RT-577 CHECK (`cash`, `card_external`). SAFETY (fail closed):
-- re-adding the narrower CHECK validates every row, so this FAILS while any
-- refund tender with method `voucher` exists (the error names the
-- constraint) and nothing changes: such a row is a recorded voucher refund and
-- must not be silently rewritten. Constraint validation is not subject to
-- row-level security, so it sees every tenant's rows. Roll back the RT-1343
-- item 2 API first, so no new voucher refund tender is written.

ALTER TABLE sale_credit_reversal_tenders
  DROP CONSTRAINT sale_credit_reversal_tenders_method_valid;

ALTER TABLE sale_credit_reversal_tenders
  ADD CONSTRAINT sale_credit_reversal_tenders_method_valid
  CHECK (method IN ('cash', 'card_external'));
