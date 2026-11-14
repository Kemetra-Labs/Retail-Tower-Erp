-- 0113_erp_provisioning_host_label_backfill.sql (RT-1389 Phase 2, owner go-ahead 2026-11-14)
-- `[GATED: migration]`. Data only (plus the function that does it); the column is 0112.
--
-- Moves the host of every `succeeded` request out of its SYNTHETIC ended lease
-- (RT-1358 known compromise) into `provisioned_host_label`, and clears the lease columns:
-- a terminal row no longer carries a lease just to remember its host. A succeeded row with
-- no lease holder (its host was never known) stays NULL: it is not counted under any host.
-- `failed_permanent` rows written before RT-1389 are NOT touched: nothing counts their ended lease,
-- the feed still reads its holder as the replay key of a repeated failure report, and the down
-- could not rebuild it. New failures keep no lease (the reporting host is in the audit row).
--
-- The work is the function `erp_provisioning_backfill_host_labels()`, called once here. It is
-- idempotent (only succeeded rows that still have a holder; a label already set must equal it,
-- which also clears the lease that 0113's down rebuilt). The api and worker
-- that run before this deploy may still write a synthetic lease while `migrate` runs, so the
-- deploy re-runs it once the new api and worker are up, as the migration owner:
--     SELECT erp_provisioning_backfill_host_labels();
-- (it returns the number of rows moved; 0 means nothing was left).
--
-- FORCE RLS: the migration owner is NOSUPERUSER, so a plain UPDATE sees no row. The
-- platform-admin policies of this table (0109) are not tenant-pinned, so one statement with
-- `app.is_platform_admin = 'true'` (transaction-local) and the NIL tenant covers every
-- tenant. The 0112 guard allows it: the status does not change and the label goes from NULL
-- to a value.
--
-- Rollback: 0113_erp_provisioning_host_label_backfill.down.sql rebuilds the synthetic ended
-- lease from the label and drops the function.

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION erp_provisioning_backfill_host_labels() RETURNS integer
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  moved integer;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  UPDATE erp_provisioning_request
     SET provisioned_host_label = lease_holder,
         lease_holder = NULL, lease_id = NULL, lease_expires_at = NULL
   WHERE status = 'succeeded'
     AND lease_holder IS NOT NULL
     AND (provisioned_host_label IS NULL OR provisioned_host_label = lease_holder);
  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END
$$;

REVOKE ALL ON FUNCTION erp_provisioning_backfill_host_labels() FROM PUBLIC;

SELECT erp_provisioning_backfill_host_labels();

COMMIT;
