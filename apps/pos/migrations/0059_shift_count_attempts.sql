-- RT-997 — every shift Count Attempt, an append-only local fact before the close.
--
-- [GATED] approval: NOT YET GRANTED. This migration needs the owner's approval
-- before it merges (RT-997 acceptance criterion 3). The decision it serves is
-- the owner's in Jira RT-276 comment 14719 (2026-10-30): "Count Attempt history
-- is needed before the pilot" (2b of the c14691 verification: V1 persisted only
-- the close itself, so a refused count wrote nothing). 0059 is the next free
-- number after 0058.
--
-- ## Why
--
-- The Shift & Cash baseline (Confluence 24674305, 1592–1625 and 1774–1797) says
-- each submitted count is a durable Count Attempt, a recount is another attempt,
-- and the first count is never erased. V1 (RT-17, 0043) keeps one count: the
-- `shift_cashup_closes` row. A count the close refused (the variance needs a
-- manager, the manager's PIN was wrong, the drawer moved before the approval)
-- left no trace, and the probe tally that counts such refusals is in memory.
--
-- ## Shape (two additive tables, nothing existing altered)
--
--   shift_count_attempts        one row per count the till EVALUATED for an open
--                               shift: who counted, how much, the outcome
--                               (`accepted` | `refused` | `abandoned`) and when.
--                               No expected cash and no variance is stored here,
--                               so the table adds nothing a cashier could read
--                               to the blind count: it holds the counted amount
--                               the cashier typed, and nothing else the cashier
--                               did not already know.
--   shift_close_count_attempts  the link "this close rests on this accepted
--                               attempt": one row per close that was made
--                               through a Count Attempt, written in the close's
--                               own transaction.
--
-- A close's own table (`shift_cashup_closes`, 0043) is NOT altered: it has its
-- own [GATED] approval (RT-17 comment 10920), and a close recorded before this
-- migration, or by a path that does not stamp an attempt, simply has no link
-- row. Nothing requires every close to have one.
--
-- `accepted` is written in the same transaction as the close, before it (the
-- insert trigger refuses an attempt on a closed shift), so an accepted attempt
-- exists exactly when its close does: if the close rolls back, so does the
-- attempt. At most one accepted attempt per shift (partial unique index).
-- `refused` is written after the till refused the count (and rolled the close
-- back). `abandoned` is allowed by the schema so no second migration is needed;
-- see the RT-997 report: nothing in the till writes it yet, because the
-- cashier's walk-away happens in the renderer, which has no channel for it.
--
-- Both tables are append-only for every role, as 0043's: UPDATE and DELETE are
-- refused by triggers. A recount is a NEW row; an earlier row is never edited.
-- Ids are the lower-case UUIDs the other facts use; money is INTEGER minor
-- units (`typeof = 'integer'`).
--
-- The facts stay on the terminal: nothing here goes in the shift sync outbox
-- (its `fact_kind` set is closed) and no wire body changes. Sending attempts to
-- Backend-Core would need an approved contract first (RT-997 criterion 4).
--
-- No secret, no PIN, no PII: ids, an amount, an outcome and instants only.
--
-- ## §A2 migration safety
--
--   • Additive only: two new tables, their indexes and triggers. No existing
--     table, column, constraint, index or trigger is altered or dropped.
--   • Ships empty, so no CHECK can fail on an existing database.
--   • Code before 0059 never names these tables, so it reads and writes every
--     other table unchanged after the migration.
--   • IF NOT EXISTS everywhere: re-applying is a no-op.
--   • Runs in the runner's per-file transaction.
--
-- ## Rollback
--
--   DROP TRIGGER IF EXISTS trg_shift_close_count_attempts_no_delete;
--   DROP TRIGGER IF EXISTS trg_shift_close_count_attempts_no_update;
--   DROP TRIGGER IF EXISTS trg_shift_close_count_attempts_accepted;
--   DROP TABLE IF EXISTS shift_close_count_attempts;
--   DROP TRIGGER IF EXISTS trg_shift_count_attempts_no_delete;
--   DROP TRIGGER IF EXISTS trg_shift_count_attempts_no_update;
--   DROP TRIGGER IF EXISTS trg_shift_count_attempts_shift_open;
--   DROP TABLE IF EXISTS shift_count_attempts;
-- restores 0058. The shifts and closes themselves are untouched; only the
-- attempt history is lost.

CREATE TABLE IF NOT EXISTS shift_count_attempts (
  attempt_id          TEXT     NOT NULL PRIMARY KEY CHECK (
    length(attempt_id) = 36
    AND attempt_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(attempt_id, 9, 1) = '-' AND substr(attempt_id, 14, 1) = '-'
    AND substr(attempt_id, 19, 1) = '-' AND substr(attempt_id, 24, 1) = '-'
    AND length(replace(attempt_id, '-', '')) = 32
  ),
  shift_id            TEXT     NOT NULL,
  actor_user_id       TEXT     NOT NULL CHECK (
    length(actor_user_id) = 36
    AND actor_user_id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(actor_user_id, '-', '')) = 32
  ),
  counted_cash_minor  INTEGER  NOT NULL CHECK (
    typeof(counted_cash_minor) = 'integer' AND counted_cash_minor >= 0
  ),
  outcome             TEXT     NOT NULL CHECK (outcome IN ('accepted', 'refused', 'abandoned')),
  attempted_at        TEXT     NOT NULL CHECK (length(attempted_at) > 0),
  created_at          TEXT     NOT NULL CHECK (length(created_at) > 0),

  FOREIGN KEY (shift_id) REFERENCES shift_cashup_opens(shift_id)
);

CREATE INDEX IF NOT EXISTS idx_shift_count_attempts_shift
  ON shift_count_attempts (shift_id, attempted_at);

-- At most one accepted attempt per shift (the one its close rests on).
CREATE UNIQUE INDEX IF NOT EXISTS ux_shift_count_attempts_accepted
  ON shift_count_attempts (shift_id)
  WHERE outcome = 'accepted';

-- An attempt is recorded only while its shift is open (an accepted one goes in
-- just before the close row, in the same transaction).
CREATE TRIGGER IF NOT EXISTS trg_shift_count_attempts_shift_open
BEFORE INSERT ON shift_count_attempts
WHEN EXISTS (SELECT 1 FROM shift_cashup_closes WHERE shift_id = NEW.shift_id)
BEGIN
  SELECT RAISE(ABORT, 'shift_count_attempts: the shift is closed (RT-997)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_count_attempts_no_update
BEFORE UPDATE ON shift_count_attempts
BEGIN
  SELECT RAISE(ABORT, 'shift_count_attempts is append-only: UPDATE is denied (RT-997)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_count_attempts_no_delete
BEFORE DELETE ON shift_count_attempts
BEGIN
  SELECT RAISE(ABORT, 'shift_count_attempts is append-only: DELETE is denied (RT-997)');
END;

-- The close's link to the accepted attempt it rests on.
CREATE TABLE IF NOT EXISTS shift_close_count_attempts (
  shift_id    TEXT  NOT NULL PRIMARY KEY,
  attempt_id  TEXT  NOT NULL UNIQUE,
  created_at  TEXT  NOT NULL CHECK (length(created_at) > 0),

  FOREIGN KEY (shift_id) REFERENCES shift_cashup_closes(shift_id),
  FOREIGN KEY (attempt_id) REFERENCES shift_count_attempts(attempt_id)
);

-- The linked attempt is the shift's ACCEPTED one and carries the close's own
-- counted cash.
CREATE TRIGGER IF NOT EXISTS trg_shift_close_count_attempts_accepted
BEFORE INSERT ON shift_close_count_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM shift_count_attempts a JOIN shift_cashup_closes c ON c.shift_id = a.shift_id
  WHERE a.attempt_id = NEW.attempt_id
    AND a.shift_id = NEW.shift_id
    AND a.outcome = 'accepted'
    AND a.counted_cash_minor = c.counted_cash_minor
)
BEGIN
  SELECT RAISE(ABORT, 'shift_close_count_attempts: the close rests on its own accepted attempt (RT-997)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_close_count_attempts_no_update
BEFORE UPDATE ON shift_close_count_attempts
BEGIN
  SELECT RAISE(ABORT, 'shift_close_count_attempts is append-only: UPDATE is denied (RT-997)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_close_count_attempts_no_delete
BEFORE DELETE ON shift_close_count_attempts
BEGIN
  SELECT RAISE(ABORT, 'shift_close_count_attempts is append-only: DELETE is denied (RT-997)');
END;
