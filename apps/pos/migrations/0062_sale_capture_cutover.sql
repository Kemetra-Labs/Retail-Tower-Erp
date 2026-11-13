-- RT-1379 — the tender and receipt capture instant, recorded once.
--
-- [GATED] approval: the owner approved the RT-1377 decision record (Confluence
-- RETAIL page 77168641) on 2026-11-13: O-1 option B with Rules 1 to 4. Rule 3
-- says the record arrives with a new POS migration and is append-only. RT-1379
-- carries it. 0062 is the next free number after 0061.
--
-- ## Why
--
-- A sale's capture body carries `tenders` (RT-79) and the `receipt` snapshot
-- (RT-540) only when it was finalized at or after a cut-off instant. Those
-- instants used to come only from two environment variables, so a terminal
-- installed from the downloaded installer sent neither. Backend-Core answers
-- 409 to a different body under the same Idempotency-Key, so the instant must
-- never move once a sale may have been sent under it. The main process writes
-- one row here right after the migrations, at the first start of this build,
-- and every later start reads it back (`sales-sync/capture-cutover.ts`).
--
-- ## Shape (one row at most, `id = 1`)
--
--   tenders_since   sales finalized at/after it carry `tenders`
--   receipt_since   sales finalized at/after it carry `receipt` (when sendable)
--   recorded_at     the wall clock when the row was written
--   source          `first_start` (computed: max(now, newest sale + 1 ms)) or
--                   `env_seed` (a valid environment value seeded a column)
--
-- The instants are explicit-zone ISO strings. Nothing secret or personal is
-- stored, and nothing here is sent to Backend-Core.
--
-- ## §A2 migration safety
--
--   • Additive only: one new table and two triggers on it; no existing table,
--     column, constraint, index or trigger is altered or dropped.
--   • Ships empty, so no CHECK can fail on an existing database. No backfill:
--     the row is written by the main process, after this migration.
--   • Code before 0062 never names the table. A build without 0062 refuses this
--     database (`SchemaAheadError`, RT-320), so the only way back is forward.
--   • Append-only: UPDATE and DELETE are refused by triggers, as in 0058. The
--     writer inserts with ON CONFLICT DO NOTHING (never REPLACE).
--   • The runner applies it in its per-file transaction, after the RT-320
--     pre-migration snapshot of the live database.
--
-- ## Rollback
--
-- Downgrades are unsupported (RT-320). By hand, on a stopped terminal:
--   DROP TRIGGER IF EXISTS trg_sale_capture_cutover_no_update;
--   DROP TRIGGER IF EXISTS trg_sale_capture_cutover_no_delete;
--   DROP TABLE IF EXISTS sale_capture_cutover;
-- restores 0061, but the next start of this build would record a new, later
-- instant: a queued sale already sent with `tenders` would then retry without
-- them (a 409). Drain the outbox first.

CREATE TABLE IF NOT EXISTS sale_capture_cutover (
  id             INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  tenders_since  TEXT    NOT NULL CHECK (length(tenders_since) > 0),
  receipt_since  TEXT    NOT NULL CHECK (length(receipt_since) > 0),
  recorded_at    TEXT    NOT NULL CHECK (length(recorded_at) > 0),
  source         TEXT    NOT NULL CHECK (source IN ('first_start', 'env_seed'))
);

-- Written once, at the first start of this build, and never edited (0058's rule).
CREATE TRIGGER IF NOT EXISTS trg_sale_capture_cutover_no_update
BEFORE UPDATE ON sale_capture_cutover
BEGIN
  SELECT RAISE(ABORT, 'sale_capture_cutover is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_capture_cutover_no_delete
BEFORE DELETE ON sale_capture_cutover
BEGIN
  SELECT RAISE(ABORT, 'sale_capture_cutover is append-only');
END;
