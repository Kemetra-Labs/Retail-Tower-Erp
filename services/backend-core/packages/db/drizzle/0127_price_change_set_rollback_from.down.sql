-- 0127_price_change_set_rollback_from.down.sql (RT-1532): drop the two CHECK constraints and the two columns.
--
-- Nothing is lost: the same two facts are still recorded in each rollback set's `pricing.change_set.created` audit row
-- (the create keeps writing them), which is where the code before this migration reads them. Rerunnable (IF EXISTS).
-- 0128's down (the backfill function) runs first in a full-chain down.

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE change_sets DROP CONSTRAINT IF EXISTS change_sets_rollback_from_whole;
ALTER TABLE change_sets DROP CONSTRAINT IF EXISTS change_sets_rollback_from_kind;
ALTER TABLE change_sets DROP COLUMN IF EXISTS rollback_from_defaulted;
ALTER TABLE change_sets DROP COLUMN IF EXISTS rollback_from;

COMMIT;
