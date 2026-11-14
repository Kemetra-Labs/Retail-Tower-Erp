-- Catch-up for the ERP provisioning host-label backfill (RT-1389, migration 0113).
--
-- Why: `migrate` runs while the PREVIOUS release's API and worker are still up. Code from
-- before 0112 finishes a `succeeded` provisioning request with a synthetic ended lease
-- (holder = the ERP host) instead of `provisioned_host_label`. A request it finishes after
-- 0113 ran keeps that lease and is missing from the new per-host site count (OD-10). Run this
-- script AFTER the new release is up (deploy step 4): from then on every writer records the
-- label, so one pass covers every row the old code left behind.
--
-- It calls the function 0113 created, which is idempotent and safe at any time (it returns
-- the number of rows moved; 0 means nothing was left). Run it as the migration owner, with
-- the connection in libpq environment variables (PGHOST/PGUSER/PGPASSWORD/...; see
-- deploy/grants.env.example), never as a URL argument:
--   psql -X -f docs/operations/sql/erp-provisioning-host-label-catchup.sql
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP).

\set ON_ERROR_STOP on

SELECT erp_provisioning_backfill_host_labels() AS rows_moved;

\echo 'OK: ERP provisioning host-label catch-up applied.'
