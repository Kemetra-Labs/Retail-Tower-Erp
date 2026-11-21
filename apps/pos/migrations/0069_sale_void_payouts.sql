-- RT-1403 S2 — the append-only record of the cash a sale void paid out of the drawer.
--
-- [GATED] approval: the owner decided in chat on 2026-11-21 (RT-1403 comment 18143) to approve a
-- GATED POS migration for slice S2: "a new append-only local payout record, additive, using the next
-- free number. It gates the payout until the void is confirmed inside an open shift; cash-up counts
-- from it." The earlier decisions (RT-530 comments 12022 and 12028) set the rule it enforces.
--
-- Numbering: 0068 is `0068_return_refund_executions` (RT-1543, #794, merged as 7ddfe0a1); this file is
-- 0069, the next number. The runner applies pending files by NAME, so the order of files never matters
-- to a till. This file touches none of 0054's or 0068's tables.
--
-- ## Why
--
-- Until now a void's cash was counted by the shift cash-up at the moment the void was REQUESTED
-- (`sale_void_journal.requested_at`, any live state), so cash "left" before Backend-Core had accepted
-- the void and before anything was handed over. The owner's fail-closed rule (RT-530 c12022): no cash
-- on a request alone; cash is paid out ONLY after Backend-Core has definitively accepted the void
-- (`confirmed`), inside an open shift, on the void's own business day and in the shift that was already
-- open when the void was requested; and a cash-out that happened anyway is recorded once, as a
-- manager-attested exception, with a mismatch flag for the manager. This table is that record, and the
-- cash-up reads void cash from it (still folded into `cashRefundsTotal`: the shift-close wire does not
-- change).
--
-- ## Shape (one row per sale whose void cash left the drawer)
--
--   payout_id         the record's identity (UUID)
--   void_id           the journaled void (0054); UNIQUE: one record per void
--   sale_id           the voided sale; UNIQUE: the cash of a sale leaves the drawer once, even if a
--                     refused void is later requested again
--   shift_id          the open shift that paid it; its cash-up counts the row
--   business_date     the store business day of the payment (for a `payout`, the void's own day)
--   kind              payout (confirmed void, through the drawer path) | exception (manager-attested)
--   method            drawer | no_drawer (a payout; RT-531: no drawer configured) | manual (exception)
--   amount_minor      the void's journaled net cash (copied; checked against the journal)
--   void_state        the void's state at the moment of the record (checked against the journal)
--   mismatch_reason   void_refused | void_unconfirmed | payout_window_closed; set only on an exception
--                     whose cash and accounting status disagree (a flag for manager reconciliation)
--   paid_at, paid_by_*  when, and which operator session handed the cash over
--   exception_*       the single-use RT-114 approval, the approving manager and the requester
--                     (`users.id`); the approver is never the requester (four-eyes)
--
-- A row is never updated and never deleted: a closed shift is never changed retroactively, and the
-- cash-up of a shift reads the row at its `paid_at`.
--
-- ## The triggers are the DB backstop of the main-process gate
--
--   void_match        the void exists in the row's scope with the same sale, cash, currency and state
--   open_shift        the shift is this terminal's, was opened before the payment, and has no close and
--                     no manager closure (a `payout` AND an `exception` both need one)
--   payout_window     a `payout` needs a `confirmed` void on its own business day, in a shift that was
--                     already open when the void was requested
--   no_update, no_delete   append-only
--
-- ## §A2 migration safety
--
--   • Additive only: one new table and five triggers on it; no existing table, column, constraint,
--     index or trigger is altered or dropped.
--   • Ships empty, so no CHECK can fail on an existing database. No backfill: a void journaled before
--     this build has no payout record and counts nothing in a cash-up until one is recorded (the void
--     feature flag is off by default).
--   • Code before 0069 never names the table. A build without 0069 refuses this database
--     (`SchemaAheadError`, RT-320), so the only way back is forward.
--   • The runner applies it in its per-file transaction, after the RT-320 pre-migration snapshot.
--
-- ## Rollback
--
-- Downgrades are unsupported (RT-320). By hand, on a stopped terminal, only when the table is empty or
-- every open shift's cash-up has been closed (the rows are cash that left a drawer):
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_void_match;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_open_shift;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_payout_window;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_no_update;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_no_delete;
--   DROP TABLE IF EXISTS sale_void_payouts;
-- Dropping it with rows loses cash movements the shift cash-up has not yet counted.

CREATE TABLE IF NOT EXISTS sale_void_payouts (
  payout_id                    TEXT    NOT NULL PRIMARY KEY CHECK (
    length(payout_id) = 36
    AND payout_id NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(payout_id, '-', '')) = 32
  ),
  void_id                      TEXT    NOT NULL UNIQUE,
  sale_id                      TEXT    NOT NULL UNIQUE,
  tenant_id                    TEXT    NOT NULL,
  branch_id                    TEXT    NOT NULL,
  terminal_id                  TEXT    NOT NULL,
  shift_id                     TEXT    NOT NULL,
  business_date                TEXT    NOT NULL CHECK (
    length(business_date) = 10 AND business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  kind                         TEXT    NOT NULL CHECK (kind IN ('payout', 'exception')),
  method                       TEXT    NOT NULL CHECK (method IN ('drawer', 'no_drawer', 'manual')),
  amount_minor                 INTEGER NOT NULL CHECK (
    typeof(amount_minor) = 'integer' AND amount_minor >= 0
  ),
  currency_code                TEXT    NOT NULL CHECK (
    length(currency_code) = 3 AND currency_code NOT GLOB '*[^A-Z]*'
  ),
  void_state                   TEXT    NOT NULL CHECK (
    void_state IN ('pending', 'unknown', 'confirmed', 'refused')
  ),
  mismatch_reason              TEXT    CHECK (
    mismatch_reason IS NULL
    OR mismatch_reason IN ('void_refused', 'void_unconfirmed', 'payout_window_closed')
  ),
  paid_at                      TEXT    NOT NULL CHECK (length(paid_at) > 0),
  paid_by_operator_id          TEXT    NOT NULL CHECK (length(paid_by_operator_id) > 0),
  paid_by_display_name         TEXT    NOT NULL,
  paid_by_session_id           TEXT    NOT NULL CHECK (length(paid_by_session_id) > 0),
  exception_approval_id        TEXT    UNIQUE CHECK (
    exception_approval_id IS NULL OR (
      length(exception_approval_id) = 36
      AND exception_approval_id NOT GLOB '*[^0-9A-Fa-f-]*'
      AND length(replace(exception_approval_id, '-', '')) = 32
    )
  ),
  exception_approver_user_id   TEXT    CHECK (
    exception_approver_user_id IS NULL OR (
      length(exception_approver_user_id) = 36
      AND exception_approver_user_id NOT GLOB '*[^0-9A-Fa-f-]*'
      AND length(replace(exception_approver_user_id, '-', '')) = 32
    )
  ),
  exception_requester_user_id  TEXT    CHECK (
    exception_requester_user_id IS NULL OR (
      length(exception_requester_user_id) = 36
      AND exception_requester_user_id NOT GLOB '*[^0-9A-Fa-f-]*'
      AND length(replace(exception_requester_user_id, '-', '')) = 32
    )
  ),
  exception_policy_version     TEXT    CHECK (
    exception_policy_version IS NULL OR length(exception_policy_version) BETWEEN 1 AND 64
  ),

  -- The method follows the kind: a drawer or no-drawer payout, or a manual (attested) exception.
  CHECK ((kind = 'exception') = (method = 'manual')),
  -- A payout is the cash of a CONFIRMED void and carries no exception evidence and no flag.
  CHECK (
    kind <> 'payout' OR (
      void_state = 'confirmed' AND mismatch_reason IS NULL
      AND exception_approval_id IS NULL AND exception_approver_user_id IS NULL
      AND exception_requester_user_id IS NULL AND exception_policy_version IS NULL
    )
  ),
  -- An exception carries the whole single-use approval; the approver is never the requester.
  CHECK (
    kind <> 'exception' OR (
      exception_approval_id IS NOT NULL AND exception_approver_user_id IS NOT NULL
      AND exception_requester_user_id IS NOT NULL AND exception_policy_version IS NOT NULL
      AND lower(exception_approver_user_id) <> lower(exception_requester_user_id)
    )
  ),
  -- The flag says why cash and accounting disagree: a refused void, an unanswered void, or a
  -- confirmed void paid outside its window.
  CHECK ((void_state = 'refused') = (COALESCE(mismatch_reason, '') = 'void_refused')),
  CHECK (
    (void_state IN ('pending', 'unknown')) = (COALESCE(mismatch_reason, '') = 'void_unconfirmed')
  ),

  FOREIGN KEY (void_id) REFERENCES sale_void_journal(void_id),
  FOREIGN KEY (sale_id) REFERENCES sales(sale_id),
  FOREIGN KEY (shift_id) REFERENCES shift_cashup_opens(shift_id)
);

-- The void must exist in the row's scope, for the same sale, cash, currency and state.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_payouts_void_match
BEFORE INSERT ON sale_void_payouts
WHEN NOT EXISTS (
  SELECT 1 FROM sale_void_journal v
   WHERE v.void_id = NEW.void_id AND v.sale_id = NEW.sale_id
     AND v.tenant_id = NEW.tenant_id AND v.branch_id = NEW.branch_id
     AND v.terminal_id = NEW.terminal_id
     AND v.cash_minor = NEW.amount_minor AND v.currency_code = NEW.currency_code
     AND v.state = NEW.void_state
)
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payouts: the void must exist in this scope with the same sale, cash, currency and state (RT-1403)');
END;

-- The shift must be this terminal's OPEN shift: opened before the payment, no close, no manager
-- closure. A closed shift is never changed.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_payouts_open_shift
BEFORE INSERT ON sale_void_payouts
WHEN NOT EXISTS (
  SELECT 1 FROM shift_cashup_opens o
   WHERE o.shift_id = NEW.shift_id
     AND o.tenant_id = NEW.tenant_id AND o.branch_id = NEW.branch_id
     AND o.terminal_id = NEW.terminal_id
     AND julianday(o.opened_at) <= julianday(NEW.paid_at)
     AND NOT EXISTS (SELECT 1 FROM shift_cashup_closes c WHERE c.shift_id = o.shift_id)
     AND NOT EXISTS (SELECT 1 FROM shift_manager_closures m WHERE m.shift_id = o.shift_id)
)
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payouts: an open shift of this terminal is required (RT-1403)');
END;

-- A payout needs a confirmed void, paid on the void's own business day, in the shift that was already
-- open when the void was requested. (Checked once the void and the shift rows exist; their own
-- triggers answer otherwise.)
CREATE TRIGGER IF NOT EXISTS trg_sale_void_payouts_payout_window
BEFORE INSERT ON sale_void_payouts
WHEN NEW.kind = 'payout'
 AND EXISTS (SELECT 1 FROM sale_void_journal v WHERE v.void_id = NEW.void_id)
 AND EXISTS (SELECT 1 FROM shift_cashup_opens o WHERE o.shift_id = NEW.shift_id)
 AND NOT EXISTS (
  SELECT 1 FROM sale_void_journal v, shift_cashup_opens o
   WHERE v.void_id = NEW.void_id AND o.shift_id = NEW.shift_id
     AND v.state = 'confirmed'
     AND v.business_date = NEW.business_date
     AND julianday(o.opened_at) <= julianday(v.requested_at)
 )
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payouts: a payout needs a confirmed void on its business day, in the same shift that was open when it was requested (payout window, RT-1403)');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_void_payouts_no_update
BEFORE UPDATE ON sale_void_payouts
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payouts: a record is immutable (RT-1403)');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_void_payouts_no_delete
BEFORE DELETE ON sale_void_payouts
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payouts is append-only: DELETE is denied (RT-1403)');
END;
