-- 0134_redistribution_proposals.down.sql - reverses 0134_redistribution_proposals.sql (RT-1600).
--
-- Drops both proposal tables (lines first: they reference the proposals). Only
-- the redistribution advice history is lost; a W3 draft Transfer an accept
-- created stays (the lines reference it, never the other way). Roll back the
-- API first: with the tables gone every proposal route fails.

BEGIN;

SET LOCAL lock_timeout = '2s';

DROP TABLE IF EXISTS redistribution_proposal_lines;
DROP TABLE IF EXISTS redistribution_proposals;

COMMIT;
