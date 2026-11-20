-- Catch-up for the Price Change Set rollback start backfill (RT-1532, migration 0128).
--
-- Why: `migrate` runs while the PREVIOUS release's API is still up. Code from before 0127 creates a rollback Change Set
-- without `rollback_from` / `rollback_from_defaulted`; a rollback set it creates after 0128 ran keeps both NULL and
-- `validate` refuses it (409 change_set_invalid_state, "cancel and recreate the rollback"). Run this script AFTER the new
-- release is up (deploy step 4): from then on every writer records the columns, so one pass covers every set the old
-- code left behind.
--
-- It calls the function 0128 created, which is idempotent and safe at any time (it returns the number of sets filled;
-- 0 means nothing was left). Run it as the migration owner, with the connection in libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL argument:
--   psql -X -f docs/operations/sql/price-change-set-rollback-from-catchup.sql
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP). The 2 s lock_timeout bounds the wait for a
-- row lock; the function takes no table lock.

\set ON_ERROR_STOP on

SET lock_timeout = '2s';

SELECT price_change_set_backfill_rollback_from() AS sets_filled;

\echo 'OK: Price Change Set rollback start catch-up applied.'
