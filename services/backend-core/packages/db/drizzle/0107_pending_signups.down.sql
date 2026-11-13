-- 0107_pending_signups.down.sql - reverses 0107_pending_signups.sql (RT-1350 slice 2).
--
-- Drops ONLY `user_consents` and `pending_signups` (their indexes, policies and
-- constraints go with them) and the guard function. DATA LOSS: every pending
-- signup and every stored consent record is discarded. Roll back the signup
-- service first; with the tables gone, signup requests would fail.
-- user_consents goes first because it references pending_signups.

BEGIN;

DROP TABLE IF EXISTS user_consents;
DROP TABLE IF EXISTS pending_signups;
DROP FUNCTION IF EXISTS pending_signups_guard();

COMMIT;
