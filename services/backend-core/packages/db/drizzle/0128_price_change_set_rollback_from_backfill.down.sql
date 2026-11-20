-- 0128_price_change_set_rollback_from_backfill.down.sql (RT-1532): drop the backfill function. The filled values stay
-- until 0127's down drops the columns; the same facts are still in each set's `created` audit row. Idempotent.

BEGIN;

SET LOCAL lock_timeout = '2s';

DROP FUNCTION IF EXISTS price_change_set_backfill_rollback_from();

COMMIT;
