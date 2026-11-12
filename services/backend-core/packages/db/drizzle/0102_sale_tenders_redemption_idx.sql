-- 0102_sale_tenders_redemption_idx.sql
--
-- One redemption pays at most one sale tender (Jira RT-1114, RT-1098 slice
-- R-4a). [GATED: migration], the same authorization as 0099 (RT-1114 comment
-- 16670). Depends on 0099 (`sale_tenders.redemption_id`). Split out of 0099
-- on review (CodeRabbit, PR #519): an index on a hot table is its own
-- CONCURRENTLY file (landing-gated-changes; the 0064 / 0085 / 0098 pattern).
--
-- uq_sale_tenders_tenant_redemption (tenant_id, redemption_id) WHERE
-- redemption_id IS NOT NULL: a voucher redemption can be spent on one tender,
-- in one sale, ever. Capture checks the same rule under the redemption row
-- lock (sale-tender-writes.ts); this index is the database backstop.
-- Partial: every cash and card tender (redemption_id NULL) stays out of it.
--
-- One statement, CONCURRENTLY: `sale_tenders` is written by every capture, and
-- the runner sends each file as one query, wrapping a multi-statement file in
-- a transaction block that CREATE INDEX CONCURRENTLY refuses. The build takes
-- SHARE UPDATE EXCLUSIVE, which blocks no read or write. If a build fails it
-- leaves an INVALID index: drop it with the down file and re-run. No IF NOT
-- EXISTS: an invalid leftover must fail loudly, never be skipped.
--
-- Deploy order: 0099 then 0102, both before POS_SALE_VOUCHER_TENDER_ENABLED is
-- ever turned on (it is default off and unmapped in compose).
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): an index only; no new data.
--
-- Reversible via 0102_sale_tenders_redemption_idx.down.sql.

CREATE UNIQUE INDEX CONCURRENTLY uq_sale_tenders_tenant_redemption
  ON sale_tenders (tenant_id, redemption_id)
  WHERE redemption_id IS NOT NULL;
