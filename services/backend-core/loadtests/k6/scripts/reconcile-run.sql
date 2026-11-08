-- RT-1281 — post-run reconciliation and ERP posting lag for one k6 run.
--
-- READ-ONLY. Run it inside a read-only transaction against the lab database
-- after the run has drained (outbox pending = 0), as an operator role that can
-- read the run's tenant. It writes nothing.
--
--   psql "$LAB_READONLY_DATABASE_URL" -v run_id="'<LOAD_RUN_ID>'" \
--        -v k6_accepted=<k6 "capture 201" passes> -f reconcile-run.sql
--
-- k6 sales carry source_system = 'k6-perf' and an external_id that starts with
-- the run id (lib/pos.js saleBody), so nothing outside the run is counted.

BEGIN TRANSACTION READ ONLY;

WITH run_sales AS (
  SELECT s.id, s.tenant_id, s.external_id, s.occurred_at, s.received_at, s.created_at
  FROM sales s
  WHERE s.source_system = 'k6-perf'
    AND s.external_id LIKE :run_id || '-%'
),
run_posts AS (
  SELECT p.sale_id, p.status, p.posted_at, p.created_at AS projected_at
  FROM erpnext_posting_status p
  JOIN run_sales rs ON rs.id = p.sale_id AND rs.tenant_id = p.tenant_id
  WHERE p.kind = 'sale_post'
)
SELECT
  :k6_accepted::bigint                                                  AS k6_accepted,
  (SELECT count(*) FROM run_sales)                                      AS sales_stored,
  (SELECT count(*) - count(DISTINCT external_id) FROM run_sales)        AS duplicate_external_ids,
  (SELECT count(*) FROM run_posts)                                      AS posting_rows,
  (SELECT count(*) FROM run_posts WHERE status = 'posted')              AS posted,
  (SELECT count(*) FROM run_posts WHERE status = 'pending')             AS still_pending,
  (SELECT count(*) FROM run_posts WHERE status = 'failed_transient')    AS failed_transient,
  (SELECT count(*) FROM run_posts WHERE status = 'permanently_rejected') AS permanently_rejected,
  (SELECT count(*) FROM run_sales rs
     WHERE NOT EXISTS (SELECT 1 FROM run_posts rp WHERE rp.sale_id = rs.id)) AS sales_without_posting_row;

-- ERP posting lag: from the sale reaching Backend-Core to the posted ack.
SELECT
  count(*)                                                                         AS posted_sales,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (rp.posted_at - rs.received_at))) AS lag_p50_s,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (rp.posted_at - rs.received_at))) AS lag_p95_s,
  max(EXTRACT(EPOCH FROM (rp.posted_at - rs.received_at)))                         AS lag_max_s
FROM run_posts rp
JOIN run_sales rs ON rs.id = rp.sale_id
WHERE rp.status = 'posted' AND rp.posted_at IS NOT NULL;

ROLLBACK;
