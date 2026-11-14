-- 0113_erp_provisioning_host_label_backfill.down.sql (RT-1389): rebuild the synthetic ended
-- lease the old code reads (holder = the recorded host, a fresh lease id, expiry = terminal_at)
-- on every succeeded row that has a label and no lease, and drop the backfill function. The
-- label itself is left in place (the 0112 guard freezes it); 0112's down drops the column.
-- Idempotent.

BEGIN;

SET LOCAL lock_timeout = '2s';

SELECT set_config('app.is_platform_admin', 'true', true);
SELECT set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);

UPDATE erp_provisioning_request
   SET lease_holder = provisioned_host_label,
       lease_id = gen_random_uuid(),
       lease_expires_at = terminal_at
 WHERE status = 'succeeded'
   AND provisioned_host_label IS NOT NULL
   AND lease_id IS NULL;

DROP FUNCTION IF EXISTS erp_provisioning_backfill_host_labels();

COMMIT;
