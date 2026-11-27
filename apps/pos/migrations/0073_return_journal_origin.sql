-- RT-1498 (RT-196 §3.3, §9) — durable capture of the originating user (`users.id`) per return.
--
-- [GATED] approval: the owner approved this GATED POS migration in chat on 2026-11-27
-- (RT-1498 comment 19115: "Approve after RT-309 (Recommended)"), unblocked once RT-309 D9
-- merged in #937 (`c41ea6b4c`).
--
-- Numbering: 0072 is `0072_create_availability_cache` (RT-1578); this file is 0073, the next
-- free number. The runner applies pending files by NAME. `0039` is NOT altered.
--
-- ## Why
--
-- `return_journal.operator_id` holds the provider operator id, not the provider-neutral `users.id`
-- that `manager_approvals` records for `approver_user_id`. Without the originating user's
-- `users.id`, resolving an unknown return (`return.resolve_unknown`) could only exclude the
-- requesting manager, not the manager who originally journaled the return (RT-196 §3.3).
--
-- ## return_journal_origin (one immutable row per newly journaled return with a known users.id)
--
--   return_id       the journaled return (0039); PRIMARY KEY, FK to return_journal
--   origin_user_id  the originating operator's provider-neutral `users.id` (lower-case, non-empty)
--   created_at      the terminal clock when journaled
--
-- Legacy rows journaled before 0073 have no row here: four-eyes excludes the requester, and the
-- resolution audit carries `origin_user_unknown: true` (RT-196 §9).
--
-- ## §A2 migration safety
--
--   • Additive only: one new table, its two immutability triggers, and one additive BEFORE INSERT
--     trigger on `return_journal_dispositions` (`trg_return_journal_dispositions_origin_four_eyes`)
--     enforcing `approver_user_id <> origin_user_id` whenever an origin row exists (leaving
--     `0070`/`0071` objects unaltered).
--   • Ships empty, so no CHECK can fail on an existing database. No backfill (legacy rows are
--     handled as `origin_user_unknown: true`).
--   • Code before 0073 never names the table. A build without 0073 refuses this database
--     (`SchemaAheadError`, RT-320), so the only way back is forward.
--   • The runner applies it in its per-file transaction, after the RT-320 pre-migration snapshot.
--
-- ## Rollback
--
-- Downgrades are unsupported (RT-320). By hand, on a stopped terminal, only when the table is empty
-- (otherwise four-eyes origin records for unresolved returns would be lost):
--   DROP TRIGGER IF EXISTS trg_return_journal_dispositions_origin_four_eyes;
--   DROP TRIGGER IF EXISTS trg_return_journal_origin_no_update;
--   DROP TRIGGER IF EXISTS trg_return_journal_origin_no_delete;
--   DROP TABLE IF EXISTS return_journal_origin;

CREATE TABLE IF NOT EXISTS return_journal_origin (
  return_id       TEXT NOT NULL PRIMARY KEY,
  origin_user_id  TEXT NOT NULL CHECK (length(origin_user_id) > 0 AND origin_user_id = lower(origin_user_id)),
  created_at      TEXT NOT NULL CHECK (length(created_at) > 0),

  FOREIGN KEY (return_id) REFERENCES return_journal(return_id)
);

CREATE TRIGGER IF NOT EXISTS trg_return_journal_origin_no_update
BEFORE UPDATE ON return_journal_origin
BEGIN
  SELECT RAISE(ABORT, 'return_journal_origin: a record is immutable (RT-1498)');
END;

CREATE TRIGGER IF NOT EXISTS trg_return_journal_origin_no_delete
BEFORE DELETE ON return_journal_origin
BEGIN
  SELECT RAISE(ABORT, 'return_journal_origin is append-only: DELETE is denied (RT-1498)');
END;

-- Enforce originator four-eyes at the database layer alongside 0070's requester four-eyes trigger.
-- Legacy pre-0073 rows have no entry in `return_journal_origin`, so EXISTS evaluates false for them.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_dispositions_origin_four_eyes
BEFORE INSERT ON return_journal_dispositions
WHEN NEW.approval_id IS NOT NULL AND EXISTS (
  SELECT 1
    FROM manager_approvals a
    JOIN return_journal_origin o ON o.return_id = NEW.return_id
   WHERE a.approval_id = NEW.approval_id
     AND lower(a.approver_user_id) = o.origin_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'return_journal_dispositions: approver cannot be the return originator (RT-1498)');
END;
