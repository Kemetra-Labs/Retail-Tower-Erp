-- RT-1442 — a shift the server says a manager closed without a count.
--
-- [GATED: migration] approval: RT-1442 comment 17322 (the owner chose "Approve
-- the device change", relayed by the captain session on 2026-11-16) approves
-- this POS SQLite migration: an append-only `shift_manager_closures` table,
-- the rebuild of the two "shift is open" triggers, and the matching change of
-- the open-shift queries in code.
--
-- ## Why
--
-- Backend-Core's `forceCloseShift` (RT-742) closes a till's shift as NOT
-- COUNTED: no totals, no variance, no cash-up. The till learns of it only
-- later, from a 409 `shift_force_closed` (a `closeShift` or an `openShift`
-- re-delivery) or a 409 `shift_closed` (a new movement). The contract says the
-- POS treats that as final: it stops sending that shift's facts and shows that
-- a manager closed it.
--
-- Locally a shift is "open" while it has no `shift_cashup_closes` row, and
-- `shift_cashup_closes` is append-only and holds a real cash-up (a counted
-- amount, the expected-cash arithmetic). A manager close is not counted, so no
-- row of that table can honestly stand for it. This table records the fact
-- without any cash field: it only says "the server closed this shift".
--
-- ## What it changes
--
--   shift_manager_closures   one row per shift the server closed without a
--                            count (append-only; never updated or deleted).
--   trg_shift_cashup_opens_one_open        a shift with a manager closure no
--                            longer blocks a new open (DROP + CREATE).
--   trg_shift_cashup_movements_shift_open  a shift with a manager closure takes
--                            no new movement (DROP + CREATE).
--
-- Nothing else is altered. In particular `shift_cashup_opens`,
-- `shift_cashup_closes`, `shift_cashup_movements` and the sync outbox / state
-- tables keep their columns, constraints and rows: nothing local is deleted,
-- recorded movements and sales keep their own sync.
--
-- ## Existing terminal databases
--
-- The table ships empty, so every shift that already exists is unchanged: an
-- open shift (no close row, no manager closure) still blocks a second open,
-- and a closed shift (a close row) still takes no movement. The rebuilt
-- triggers differ from 0043's only by the extra `shift_manager_closures`
-- clause. Forward-only; re-applying is a no-op (`IF NOT EXISTS` for the table,
-- DROP + CREATE of the triggers). Runs in the runner's per-file transaction.
--
-- No secret and no PII: a shift id, the fact kind that carried the answer and
-- two instants.
--
-- ## Rollback (manual, not run by the app)
--
--   DROP TRIGGER trg_shift_cashup_opens_one_open;
--   DROP TRIGGER trg_shift_cashup_movements_shift_open;
--   -- re-create both from 0043, then:
--   DROP TABLE shift_manager_closures;

CREATE TABLE IF NOT EXISTS shift_manager_closures (
  shift_id          TEXT     NOT NULL PRIMARY KEY CHECK (
    length(shift_id) = 36
    AND shift_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(shift_id, 9, 1) = '-' AND substr(shift_id, 14, 1) = '-'
    AND substr(shift_id, 19, 1) = '-' AND substr(shift_id, 24, 1) = '-'
    AND length(replace(shift_id, '-', '')) = 32
  ),
  -- The fact whose answer told the till: an `open` or `close` (409
  -- `shift_force_closed`) or a `movement` (409 `shift_closed`).
  source_fact_kind  TEXT     NOT NULL CHECK (source_fact_kind IN ('open', 'movement', 'close')),
  -- ISO-8601 UTC: when the till learned of it.
  recorded_at       TEXT     NOT NULL CHECK (length(recorded_at) > 0),

  FOREIGN KEY (shift_id) REFERENCES shift_cashup_opens(shift_id)
);

CREATE TRIGGER IF NOT EXISTS trg_shift_manager_closures_no_update
BEFORE UPDATE ON shift_manager_closures
BEGIN
  SELECT RAISE(ABORT, 'shift_manager_closures is append-only: UPDATE is denied (RT-1442)');
END;

CREATE TRIGGER IF NOT EXISTS trg_shift_manager_closures_no_delete
BEFORE DELETE ON shift_manager_closures
BEGIN
  SELECT RAISE(ABORT, 'shift_manager_closures is append-only: DELETE is denied (RT-1442)');
END;

-- At most one open shift per terminal, where a shift closed by a manager is no
-- longer open (0043's rule plus the manager-closure clause).
DROP TRIGGER IF EXISTS trg_shift_cashup_opens_one_open;
CREATE TRIGGER trg_shift_cashup_opens_one_open
BEFORE INSERT ON shift_cashup_opens
WHEN EXISTS (
  SELECT 1 FROM shift_cashup_opens s
  WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id
    AND s.terminal_id = NEW.terminal_id
    AND NOT EXISTS (SELECT 1 FROM shift_cashup_closes c WHERE c.shift_id = s.shift_id)
    AND NOT EXISTS (SELECT 1 FROM shift_manager_closures m WHERE m.shift_id = s.shift_id)
)
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_opens: this terminal already has an open shift (RT-17)');
END;

-- A movement is recorded only on an open shift (not closed, not closed by a manager).
DROP TRIGGER IF EXISTS trg_shift_cashup_movements_shift_open;
CREATE TRIGGER trg_shift_cashup_movements_shift_open
BEFORE INSERT ON shift_cashup_movements
WHEN EXISTS (SELECT 1 FROM shift_cashup_closes WHERE shift_id = NEW.shift_id)
  OR EXISTS (SELECT 1 FROM shift_manager_closures WHERE shift_id = NEW.shift_id)
BEGIN
  SELECT RAISE(ABORT, 'shift_cashup_movements: the shift is closed (RT-17)');
END;
