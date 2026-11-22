-- RT-1553 — re-block a sale when a return the till CLOSED as "not recorded" is later seen as recorded.
--
-- [GATED] approval: the owner authorized this GATED POS migration in chat on 2026-11-23 (RT-1553
-- scope item 1, finding F-1 of the RT-1498 close slice). The contract is RT-1196 / RT-1548: when a key
-- that was closed as `not_recorded` is later seen as recorded, the POS raises a `needs_support`
-- mismatch, and that mismatch blocks the sale again.
--
-- Numbering: 0070 is `0070_return_journal_dispositions` (RT-1498 S4, #799, merged as 5d5a6182c); this
-- file is 0071, the next number. The runner applies pending files by NAME. 0070 is NOT edited.
--
-- ## Why
--
-- 0070's `trg_return_journal_dispositions_header` refuses ANY disposition after a close, so the late
-- commit could only be audited. This file recreates that one trigger with one exception: after a
-- `not_recorded_closed`, exactly one more row may be written, and only
--
--   kind = needs_support, verdict_source = provenance_read, reason = mismatch,
--   approval_id IS NULL, actor_operator_id IS NOT NULL
--
-- (the 0070 CHECK already requires `read_verdict_at` for that combination). Nothing else is allowed
-- after a close: no second close (also the unique index), no `retry_hold`, no operator escalation, no
-- automatic `send_response` / `auth_failure` raise, and no second late-commit raise.
--
-- The close row stays. The readers order the two rows by rowid (the table is append-only: UPDATE and
-- DELETE are denied, so a later row always has a larger rowid): a close followed by this row is a
-- SUPPORT state that blocks the sale again (a new return, a void). The closed journal row is still
-- frozen (`trg_return_journal_closed_frozen`, unchanged): it can never be confirmed, so it can never be
-- paid out.
--
-- ## §A2 migration safety
--
--   • Additive in effect: one trigger is dropped and recreated with the SAME name, table and timing;
--     every write the 0070 trigger allowed is still allowed, and the only new write is the one above.
--     No table, column, constraint or index is created, altered or dropped. No row is written.
--   • The DROP and the CREATE run in the runner's per-file transaction, so the table is never without
--     its header trigger.
--   • Code before 0071 never writes the new row, and a build without 0071 refuses this database
--     (`SchemaAheadError`, RT-320), so the only way back is forward.
--   • The runner applies it in its per-file transaction, after the RT-320 pre-migration snapshot.
--
-- ## Rollback
--
-- Downgrades are unsupported (RT-320). By hand, on a stopped terminal, only when no late-commit row
-- exists (a late-commit row is support evidence and must be reconciled first), recreate the 0070 header:
--   DROP TRIGGER IF EXISTS trg_return_journal_dispositions_header;
--   then the `CREATE TRIGGER ... trg_return_journal_dispositions_header` statement of 0070.

DROP TRIGGER IF EXISTS trg_return_journal_dispositions_header;

-- A disposition belongs to a return that is still unresolved and was sent. After a close, only the
-- single late-commit support raise (RT-1553) is allowed.
CREATE TRIGGER trg_return_journal_dispositions_header
BEFORE INSERT ON return_journal_dispositions
BEGIN
  SELECT RAISE(ABORT, 'return_journal_dispositions: the return is already closed (header, RT-1498)')
   WHERE EXISTS (
     SELECT 1 FROM return_journal_dispositions d
      WHERE d.return_id = NEW.return_id AND d.kind = 'not_recorded_closed'
   )
     AND NOT (
       NEW.kind = 'needs_support'
       AND NEW.verdict_source = 'provenance_read'
       AND NEW.reason = 'mismatch'
       AND NEW.approval_id IS NULL
       AND NEW.actor_operator_id IS NOT NULL
     );
  SELECT RAISE(ABORT, 'return_journal_dispositions: the late commit of this closed return is already raised (header, RT-1553)')
   WHERE EXISTS (
     SELECT 1 FROM return_journal_dispositions c
      JOIN return_journal_dispositions s
        ON s.return_id = c.return_id AND s.kind = 'needs_support' AND s.rowid > c.rowid
      WHERE c.return_id = NEW.return_id AND c.kind = 'not_recorded_closed'
   );
  SELECT RAISE(ABORT, 'return_journal_dispositions: the return must be unknown or sent (header, RT-1498)')
   WHERE NOT EXISTS (
     SELECT 1 FROM return_journal j
      WHERE j.return_id = NEW.return_id
        AND (j.state = 'unknown' OR (j.state = 'pending' AND j.attempt_count > 0))
   );
END;
