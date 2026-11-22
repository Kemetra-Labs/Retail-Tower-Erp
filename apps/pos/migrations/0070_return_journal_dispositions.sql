-- RT-1498 S4 — the append-only local record of how a permanently-unknown return was disposed of.
--
-- [GATED] approval: the owner decided in chat on 2026-11-21 (RT-1498 comment 18144, item 2) to
-- approve a GATED POS migration for slice S4: "a new append-only local dispositions table holding the
-- close and escalate records and the `needs_support` state. It is additive and takes the next free
-- number after RT-1403's payout-record migration." The design is RT-196 §3.4 (OD-196-2, owner-approved
-- 2026-10-18, RT-196 comment 12801); RT-196 comment 12801 gaps 1 and 2 are settled by RT-1498 c18144
-- (gap 1) and c18144 item 3 (gap 2).
--
-- Numbering: 0069 is `0069_sale_void_payouts` (RT-1403 S2, #797, merged as 6c131309f); this file is
-- 0070, the next number. The runner applies pending files by NAME. `0039` is NOT altered (OD-196-2).
--
-- ## Why
--
-- A return whose state is permanently `unknown` blocks further returns and voids on its sale
-- (`unresolved_return_exists`) and is resent forever. The operator path needs a place to say, once and
-- for good, "this return was never recorded: close it" or "this needs support: stop resending it". The
-- `return_journal` state machine (0039) has no state for either and a new state would mean rebuilding
-- a money table, so each decision is one append-only row here.
--
-- ## return_journal_dispositions (one row per decision; never updated, never deleted)
--
--   disposition_id    the row's identity (UUID, 36 characters); PRIMARY KEY
--   return_id         the journaled return (0039)
--   kind              not_recorded_closed  TERMINAL: the sale is freed, the return is never sent again
--                     needs_support        restrict-only flag: no automatic resend; the sale stays blocked
--                     retry_hold           restrict-only flag written by a status read that answered
--                                          "not recorded" (reserved: its writer is the owed status read)
--   verdict_source    provenance_read | send_response | auth_failure | operator
--   reason            not_recorded | mismatch | auth_failure | operator
--   read_verdict_at   when the status read answered; set exactly when the source is `provenance_read`
--   approval_id       the single-use RT-114 approval of kind `return.resolve_unknown` that backs it
--   actor_operator_id the operator session that wrote it; NULL for the automatic raises
--   created_at        the terminal clock
--
-- ## The closed combinations (CHECK)
--
--   not_recorded_closed  provenance_read + not_recorded, an approval, an actor and a read time
--   needs_support        operator          + operator    approval + actor           (a manager's raise)
--                        send_response     + mismatch    no approval, no actor      (automatic, U-3/U-4)
--                        auth_failure      + auth_failure no approval, no actor     (automatic, §3.6)
--                        provenance_read   + mismatch    NO approval, an actor      (Gap 2: the server
--                                                         proved a mismatch; the flag only restricts)
--   retry_hold           provenance_read + not_recorded, no approval, an actor, a read time
--
-- ## One approval kind, the disposition bound (Gap 1, RT-1498 c18144 item 1)
--
-- There is ONE approval kind, `return.resolve_unknown`. The approval's `subject_ref` is
-- `<return_id>_close` or `<return_id>_escalate`, so an approval granted for one disposition is not
-- valid for the other (the approval service compares the subject_ref for equality on consume, and the
-- `approval` trigger below repeats it here). A row that cites an approval needs it to exist, to be
-- spent, to be of that kind, to be bound to THIS return and THIS disposition, to be on the return's
-- terminal and to carry the return's quoted amount. One approval backs one disposition.
--
-- ## Triggers
--
--   header    a disposition is written only while the return is `unknown`, or `pending` and sent at
--             least once (`attempt_count > 0`), and never after a close
--   approval  the approval rule above
--   no_update / no_delete  the record is immutable
--   trg_return_journal_closed_frozen  (on the EXISTING 0039 `return_journal` table: it adds a trigger,
--             changes no column, and is inert until a close exists; precedent 0040 and 0053)
--             once a return is closed its `state`, `attempt_count` and `last_attempt_at` cannot change:
--             it can no longer be confirmed, refused or re-attempted, whoever writes. This is the DB
--             backstop of "a closed row is never sent again".
--
-- ## §A2 migration safety
--
--   • Additive only: one new table, its indexes and triggers, and one new trigger on `return_journal`;
--     no existing table, column, constraint or index is altered or dropped.
--   • Ships empty, so no CHECK can fail on an existing database. No backfill: a return journaled before
--     this build simply has no disposition.
--   • Code before 0070 never names the table. A build without 0070 refuses this database
--     (`SchemaAheadError`, RT-320), so the only way back is forward.
--   • The runner applies it in its per-file transaction, after the RT-320 pre-migration snapshot.
--
-- ## Rollback
--
-- Downgrades are unsupported (RT-320). By hand, on a stopped terminal, only when the table is empty
-- (a close frees a sale for a second refund, so a populated table must be reconciled first):
--   DROP TRIGGER IF EXISTS trg_return_journal_closed_frozen;
--   DROP TRIGGER IF EXISTS trg_return_journal_dispositions_header;
--   DROP TRIGGER IF EXISTS trg_return_journal_dispositions_approval;
--   DROP TRIGGER IF EXISTS trg_return_journal_dispositions_no_update;
--   DROP TRIGGER IF EXISTS trg_return_journal_dispositions_no_delete;
--   DROP TABLE IF EXISTS return_journal_dispositions;

CREATE TABLE IF NOT EXISTS return_journal_dispositions (
  disposition_id     TEXT  NOT NULL PRIMARY KEY CHECK (length(disposition_id) = 36),
  return_id          TEXT  NOT NULL,
  kind               TEXT  NOT NULL CHECK (kind IN ('not_recorded_closed', 'needs_support', 'retry_hold')),
  verdict_source     TEXT  NOT NULL CHECK (
    verdict_source IN ('provenance_read', 'send_response', 'auth_failure', 'operator')
  ),
  reason             TEXT  NOT NULL CHECK (reason IN ('not_recorded', 'mismatch', 'auth_failure', 'operator')),
  read_verdict_at    TEXT,
  approval_id        TEXT  CHECK (approval_id IS NULL OR (length(approval_id) = 36 AND approval_id = lower(approval_id))),
  actor_operator_id  TEXT  CHECK (actor_operator_id IS NULL OR length(actor_operator_id) > 0),
  created_at         TEXT  NOT NULL CHECK (length(created_at) > 0),

  CHECK (
    (kind = 'not_recorded_closed'
      AND verdict_source = 'provenance_read' AND reason = 'not_recorded'
      AND approval_id IS NOT NULL AND actor_operator_id IS NOT NULL AND read_verdict_at IS NOT NULL)
    OR (kind = 'retry_hold'
      AND verdict_source = 'provenance_read' AND reason = 'not_recorded'
      AND approval_id IS NULL AND actor_operator_id IS NOT NULL AND read_verdict_at IS NOT NULL)
    OR (kind = 'needs_support' AND (
      (verdict_source = 'operator' AND reason = 'operator'
        AND approval_id IS NOT NULL AND actor_operator_id IS NOT NULL AND read_verdict_at IS NULL)
      OR (verdict_source = 'send_response' AND reason = 'mismatch'
        AND approval_id IS NULL AND actor_operator_id IS NULL AND read_verdict_at IS NULL)
      OR (verdict_source = 'auth_failure' AND reason = 'auth_failure'
        AND approval_id IS NULL AND actor_operator_id IS NULL AND read_verdict_at IS NULL)
      OR (verdict_source = 'provenance_read' AND reason = 'mismatch'
        AND approval_id IS NULL AND actor_operator_id IS NOT NULL AND read_verdict_at IS NOT NULL)
    ))
  ),

  FOREIGN KEY (return_id) REFERENCES return_journal(return_id)
);

-- At most one terminal close per return (the concurrency backstop of the `header` trigger).
CREATE UNIQUE INDEX IF NOT EXISTS ux_return_journal_dispositions_one_close
  ON return_journal_dispositions (return_id)
  WHERE kind = 'not_recorded_closed';

-- One approval backs one disposition (single use).
CREATE UNIQUE INDEX IF NOT EXISTS ux_return_journal_dispositions_approval
  ON return_journal_dispositions (approval_id)
  WHERE approval_id IS NOT NULL;

-- Reader lookup: a return's dispositions by kind.
CREATE INDEX IF NOT EXISTS idx_return_journal_dispositions_return
  ON return_journal_dispositions (return_id, kind);

-- A disposition belongs to a return that is still unresolved and was sent, and never follows a close.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_dispositions_header
BEFORE INSERT ON return_journal_dispositions
BEGIN
  SELECT RAISE(ABORT, 'return_journal_dispositions: the return is already closed (header, RT-1498)')
   WHERE EXISTS (
     SELECT 1 FROM return_journal_dispositions d
      WHERE d.return_id = NEW.return_id AND d.kind = 'not_recorded_closed'
   );
  SELECT RAISE(ABORT, 'return_journal_dispositions: the return must be unknown or sent (header, RT-1498)')
   WHERE NOT EXISTS (
     SELECT 1 FROM return_journal j
      WHERE j.return_id = NEW.return_id
        AND (j.state = 'unknown' OR (j.state = 'pending' AND j.attempt_count > 0))
   );
END;

-- A disposition that cites an approval cites a spent `return.resolve_unknown` approval bound to THIS
-- return and THIS disposition (`_close` for a close, `_escalate` for needs_support), on the return's
-- terminal and for its quoted amount. It must also have been requested by THIS disposition's actor
-- (`requester_operator_id = actor_operator_id`) and approved by a manager other than the requester
-- (four-eyes, as 0069 does for its exception); a NULL requester `users.id` fails closed. 0048 stores
-- `approval_id` in lower case (a CHECK), so it is compared directly and the primary-key index is used.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_dispositions_approval
BEFORE INSERT ON return_journal_dispositions
WHEN NEW.approval_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM manager_approvals a
    JOIN return_journal j ON j.return_id = NEW.return_id
   WHERE a.approval_id = NEW.approval_id
     AND a.action_kind = 'return.resolve_unknown'
     AND a.subject_ref = NEW.return_id || '_' ||
       CASE NEW.kind WHEN 'not_recorded_closed' THEN 'close' ELSE 'escalate' END
     AND a.tenant_id = j.tenant_id AND a.branch_id = j.branch_id AND a.terminal_id = j.terminal_id
     AND a.amount_minor = j.quoted_total_minor
     AND a.requester_operator_id = NEW.actor_operator_id
     AND lower(a.approver_user_id) <> lower(a.requester_user_id)
     AND a.consumed_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'return_journal_dispositions: needs a spent approval of this kind, for this return, disposition and actor, approved by another manager (approval, RT-1498)');
END;

CREATE TRIGGER IF NOT EXISTS trg_return_journal_dispositions_no_update
BEFORE UPDATE ON return_journal_dispositions
BEGIN
  SELECT RAISE(ABORT, 'return_journal_dispositions: a record is immutable (RT-1498)');
END;

CREATE TRIGGER IF NOT EXISTS trg_return_journal_dispositions_no_delete
BEFORE DELETE ON return_journal_dispositions
BEGIN
  SELECT RAISE(ABORT, 'return_journal_dispositions is append-only: DELETE is denied (RT-1498)');
END;

-- A closed return is frozen: it can no longer be confirmed, refused or re-attempted.
CREATE TRIGGER IF NOT EXISTS trg_return_journal_closed_frozen
BEFORE UPDATE ON return_journal
WHEN (
    NEW.state IS NOT OLD.state
    OR NEW.attempt_count IS NOT OLD.attempt_count
    OR NEW.last_attempt_at IS NOT OLD.last_attempt_at
  )
  AND EXISTS (
    SELECT 1 FROM return_journal_dispositions d
     WHERE d.return_id = OLD.return_id AND d.kind = 'not_recorded_closed'
  )
BEGIN
  SELECT RAISE(ABORT, 'return_journal: the return is closed and can no longer change (RT-1498)');
END;
