-- 0090_device_health_sale_queue.down.sql
--
-- Reverses 0090: drops ONLY the RT-1312 sale queue columns and their
-- constraints from device_health. Rerunnable.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE device_health
  DROP CONSTRAINT IF EXISTS device_health_sale_queue_consistent,
  DROP CONSTRAINT IF EXISTS device_health_sale_queue_bounds;

ALTER TABLE device_health
  DROP COLUMN IF EXISTS sale_queue_oldest_pending_at,
  DROP COLUMN IF EXISTS sale_queue_held,
  DROP COLUMN IF EXISTS sale_queue_dead_letter,
  DROP COLUMN IF EXISTS sale_queue_pending;

COMMIT;
