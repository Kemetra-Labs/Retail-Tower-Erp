-- RT-363 fix-forward — the one-tender-per-line capture instant, recorded once.
--
-- [GATED] approval: the owner decided in chat on 2026-11-21 ("Fix-forward, record it"),
-- recorded on Jira RT-363 comment 18091: record this cut-off once in the POS local
-- database like RT-1379 (0062), with a GATED POS local migration approved by that decision.
-- 0066 is the next free number after 0065.
--
-- ## Why
--
-- A sale finalized at or after the instant (and past the 0062 tenders instant) sends one
-- `tenders` entry per tender line, each with `tenderRef` and `sequence` (RT-363), instead of
-- one entry per method. That instant used to be read from
-- `POS_PULSE_FEATURE_SALE_TENDER_REFS_SINCE` at every start. Backend-Core answers 409 to a
-- different body under the same Idempotency-Key, so a variable that was removed, lost or moved
-- while a sale was retrying changed that sale's body and dead-lettered it. The main process now
-- writes one row here, at the first start whose environment holds a valid value, and every
-- later start reads it back (`sales-sync/tender-refs-cutoff.ts`). No row means the per-line
-- body is off (the default): unlike 0062, the first start of a build does not write one, because
-- the per-line body must not reach Backend-Core before its same-method flag is on (RT-360).
--
-- ## Shape (one row at most, `id = 1`)
--
--   tender_refs_since  sales finalized at/after it (and past 0062's tenders instant) send one
--                      tender per line
--   recorded_at        the wall clock when the row was written
--   source             `env_opt_in` (the only value: a valid environment value opted in; the
--                      stored instant is max(that value, now, newest sale + 1 ms))
--
-- The instants are explicit-zone ISO strings. Nothing secret or personal is stored, and
-- nothing here is sent to Backend-Core.
--
-- ## §A2 migration safety
--
--   • Additive only: one new table and two triggers on it; no existing table, column,
--     constraint, index or trigger is altered or dropped.
--   • Ships empty, so no CHECK can fail on an existing database. No backfill: the row is
--     written by the main process, after this migration, and only on opt-in.
--   • Code before 0066 never names the table. A build without 0066 refuses this database
--     (`SchemaAheadError`, RT-320), so the only way back is forward.
--   • Append-only: UPDATE and DELETE are refused by triggers, as in 0058 and 0062. The writer
--     inserts with ON CONFLICT DO NOTHING (never REPLACE).
--   • The runner applies it in its per-file transaction, after the RT-320 pre-migration
--     snapshot of the live database.
--
-- ## Rollback
--
-- Downgrades are unsupported (RT-320). By hand, on a stopped terminal:
--   DROP TRIGGER IF EXISTS trg_sale_tender_refs_cutover_no_update;
--   DROP TRIGGER IF EXISTS trg_sale_tender_refs_cutover_no_delete;
--   DROP TABLE IF EXISTS sale_tender_refs_cutover;
-- turns the per-line body off, but a queued sale already sent per line would then retry as
-- one entry per method (a 409), and a start with the variable still set would record a new,
-- later instant. Drain the outbox first and unset the variable.

CREATE TABLE IF NOT EXISTS sale_tender_refs_cutover (
  id                 INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  tender_refs_since  TEXT    NOT NULL CHECK (length(tender_refs_since) > 0),
  recorded_at        TEXT    NOT NULL CHECK (length(recorded_at) > 0),
  source             TEXT    NOT NULL CHECK (source IN ('env_opt_in'))
);

-- Written once, on opt-in, and never edited (0058's rule).
CREATE TRIGGER IF NOT EXISTS trg_sale_tender_refs_cutover_no_update
BEFORE UPDATE ON sale_tender_refs_cutover
BEGIN
  SELECT RAISE(ABORT, 'sale_tender_refs_cutover is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_tender_refs_cutover_no_delete
BEFORE DELETE ON sale_tender_refs_cutover
BEGIN
  SELECT RAISE(ABORT, 'sale_tender_refs_cutover is append-only');
END;
