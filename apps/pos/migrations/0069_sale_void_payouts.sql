-- RT-1403 S2 — the claim and the record of the cash a sale void paid out of the drawer.
--
-- [GATED] approval: the owner decided in chat on 2026-11-21 (RT-1403 comment 18143) to approve a
-- GATED POS migration for slice S2: "a new append-only local payout record, additive, using the next
-- free number. It gates the payout until the void is confirmed inside an open shift; cash-up counts
-- from it." The earlier decisions (RT-530 comments 12022 and 12028) set the rule it enforces. The
-- orchestrator's decisions after the pre-merge review (RT-1403 comment 18153, H1) add the claim: the
-- drawer is never kicked before a durable record of the payout exists, as RT-15 does for returns.
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
-- manager-attested exception, with a mismatch flag for the manager. The cash-up reads void cash from
-- the payout record (still folded into `cashRefundsTotal`: the shift-close wire does not change).
--
-- ## The order (chosen so that a crash at any step never pays twice), as RT-15 (0040) does for returns
--
--   1. claim   INSERT the claim, mark the kick about to be sent, and audit `payout_started`, one
--              transaction, BEFORE the drawer opens;
--   2. kick    the drawer;
--   3. record  INSERT the payout record (the counted cash), once the kick opened (or no drawer is
--              configured, or a manager attested a manual payout), with its audit, one transaction.
--
-- A crash between 1 and 3 leaves a claim and no record. The till then never offers a fresh payout
-- (the drawer may already have opened and the cash may be gone): only a drawer retry (after a kick that
-- provably never reached the hardware) or a manager-attested manual completion remains. A claim with no
-- record counts as drawer activity in flight, so the shift cannot close over it.
--
-- ## sale_void_payout_claims (one row per sale whose payout was started)
--
--   void_id           the confirmed void (0054); PRIMARY KEY: one claim per void
--   sale_id           the voided sale; UNIQUE: one claim per sale
--   shift_id          the open shift that claimed it (the record that completes it is in the same shift)
--   business_date     the business day of the claim (the day of `claimed_at`); the trigger requires it to
--                     be the void's own day
--   claimed_by_*, claimed_at   who started it, in which session, when (immutable)
--   kick_outcome, kick_count, kicked_at   the drawer kick, as in 0040: `sending` is written before the
--                     transport is called (after a crash it reads as unknown); `opened`;
--                     `failed_before_send` (no drawer configured: the only outcome that allows a retry);
--                     `unknown` (anything else).
--
-- ## sale_void_payouts (one row per sale whose void cash left the drawer: the COUNTED record)
--
--   payout_id         the record's identity (UUID)
--   void_id           the journaled void (0054); UNIQUE: one record per void
--   sale_id           the voided sale; UNIQUE: the cash of a sale leaves the drawer once, even if a
--                     refused void is later requested again
--   shift_id          the open shift that paid it; its cash-up counts the row
--   business_date     the store business day of the payment (the day of `paid_at`)
--   kind              payout (completes a claim; the gated path) | exception (manager-attested)
--   method            drawer | no_drawer (RT-531: no drawer configured) | manual (a manager attested a
--                     payout from a drawer opened by hand; always the method of an exception)
--   amount_minor      the void's journaled net cash (copied; checked against the journal)
--   void_state        the void's state at the moment of the record (checked against the journal)
--   mismatch_reason   void_refused | void_unconfirmed | payout_window_closed; set only on an exception
--                     whose cash and accounting status disagree (a flag for manager reconciliation)
--   paid_at, paid_by_*  when, and which operator session handed the cash over
--   exception_*       the single-use RT-114 approval, the approving manager and the requester
--                     (`users.id`); the approver is never the requester (four-eyes)
--
-- A record is never updated and never deleted: a closed shift is never changed retroactively, and the
-- cash-up of a shift reads the row at its `paid_at`. A claim is never deleted and only its kick state
-- moves, forward.
--
-- ## The triggers are the DB backstop of the main-process gate
--
--   claims:   start (a confirmed void with cash, its day, an open shift that was already open when the
--             void was requested, a sale with no record yet), identity immutable, kick guard,
--             no delete
--   records:  void_match (the void exists in the row's scope with the same sale, cash, currency, state),
--             open_shift (this terminal's open shift, opened before the payment), payout_window (a
--             `payout` needs a confirmed void on the day of payment, in the shift open at the request),
--             claim (a `payout` needs its claim, in the same shift; a `drawer` record needs a kick that
--             opened, a `no_drawer` record a kick that never left, and no kick may be in flight),
--             exception_approval (the approval exists, is of kind `sale.void_cash_exception`, is spent,
--             and covers this void, terminal, cash amount and policy, for this requester and approver), no_update, no_delete
--
-- ## §A2 migration safety
--
--   • Additive only: two new tables and their triggers; no existing table, column, constraint,
--     index or trigger is altered or dropped.
--   • Ships empty, so no CHECK can fail on an existing database. No backfill: a void journaled before
--     this build has no claim or record and counts nothing in a cash-up until one is recorded (the void
--     feature flag is off by default).
--   • Code before 0069 never names the tables. A build without 0069 refuses this database
--     (`SchemaAheadError`, RT-320), so the only way back is forward.
--   • The runner applies it in its per-file transaction, after the RT-320 pre-migration snapshot.
--
-- ## Rollback
--
-- Downgrades are unsupported (RT-320). By hand, on a stopped terminal, only when both tables are empty or
-- every open shift's cash-up has been closed (the rows are cash that left a drawer):
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_void_match;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_open_shift;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_payout_window;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_claim;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_exception_approval;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_no_update;
--   DROP TRIGGER IF EXISTS trg_sale_void_payouts_no_delete;
--   DROP TABLE IF EXISTS sale_void_payouts;
--   DROP TRIGGER IF EXISTS trg_sale_void_payout_claims_start;
--   DROP TRIGGER IF EXISTS trg_sale_void_payout_claims_identity_immutable;
--   DROP TRIGGER IF EXISTS trg_sale_void_payout_claims_kick_guard;
--   DROP TRIGGER IF EXISTS trg_sale_void_payout_claims_no_delete;
--   DROP TABLE IF EXISTS sale_void_payout_claims;
-- Dropping them with rows loses cash movements the shift cash-up has not yet counted.

CREATE TABLE IF NOT EXISTS sale_void_payout_claims (
  void_id                  TEXT    NOT NULL PRIMARY KEY,
  sale_id                  TEXT    NOT NULL UNIQUE,
  tenant_id                TEXT    NOT NULL,
  branch_id                TEXT    NOT NULL,
  terminal_id              TEXT    NOT NULL,
  shift_id                 TEXT    NOT NULL,
  business_date            TEXT    NOT NULL CHECK (
    length(business_date) = 10 AND business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  claimed_by_operator_id   TEXT    NOT NULL CHECK (length(claimed_by_operator_id) > 0),
  claimed_by_display_name  TEXT    NOT NULL,
  claimed_by_session_id    TEXT    NOT NULL CHECK (length(claimed_by_session_id) > 0),
  claimed_at               TEXT    NOT NULL CHECK (length(claimed_at) > 0),
  kick_outcome             TEXT    CHECK (
    kick_outcome IS NULL
    OR kick_outcome IN ('sending', 'opened', 'failed_before_send', 'unknown')
  ),
  kick_count               INTEGER NOT NULL DEFAULT 0 CHECK (kick_count >= 0),
  kicked_at                TEXT,

  CHECK ((kick_outcome IS NULL) = (kick_count = 0)),
  CHECK ((kick_outcome IS NULL) = (kicked_at IS NULL)),

  FOREIGN KEY (void_id) REFERENCES sale_void_journal(void_id),
  FOREIGN KEY (sale_id) REFERENCES sales(sale_id),
  FOREIGN KEY (shift_id) REFERENCES shift_cashup_opens(shift_id)
);

-- A claim starts only for a confirmed void with cash, on its own business day, in an open shift that was
-- already open when the void was requested, with no cash record for the sale yet, and never kicked.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_payout_claims_start
BEFORE INSERT ON sale_void_payout_claims
WHEN NEW.kick_outcome IS NOT NULL OR NEW.kick_count <> 0
  OR NOT EXISTS (
    SELECT 1 FROM sale_void_journal v, shift_cashup_opens o
     WHERE v.void_id = NEW.void_id AND v.sale_id = NEW.sale_id
       AND v.tenant_id = NEW.tenant_id AND v.branch_id = NEW.branch_id
       AND v.terminal_id = NEW.terminal_id
       AND v.state = 'confirmed' AND v.cash_minor > 0
       AND v.business_date = NEW.business_date
       AND o.shift_id = NEW.shift_id
       AND o.tenant_id = NEW.tenant_id AND o.branch_id = NEW.branch_id
       AND o.terminal_id = NEW.terminal_id
       AND julianday(o.opened_at) <= julianday(v.requested_at)
       AND julianday(o.opened_at) <= julianday(NEW.claimed_at)
       AND NOT EXISTS (SELECT 1 FROM shift_cashup_closes c WHERE c.shift_id = o.shift_id)
       AND NOT EXISTS (SELECT 1 FROM shift_manager_closures m WHERE m.shift_id = o.shift_id)
  )
  OR EXISTS (SELECT 1 FROM sale_void_payouts p WHERE p.sale_id = NEW.sale_id)
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payout_claims: a claim needs a confirmed void with cash, on its day, in the shift open at its request, and a sale with no cash record yet (RT-1403)');
END;

-- Who claimed it, and when, never changes.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_payout_claims_identity_immutable
BEFORE UPDATE OF void_id, sale_id, tenant_id, branch_id, terminal_id, shift_id, business_date,
  claimed_by_operator_id, claimed_by_display_name, claimed_by_session_id, claimed_at
ON sale_void_payout_claims
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payout_claims: the identity of a claim is immutable (RT-1403)');
END;

-- At most one kick per claim unless the previous kick provably never reached the hardware: a new kick
-- (-> sending, counted) only from no kick or from failed_before_send; a sent kick resolves once to
-- opened / failed_before_send / unknown; opened and unknown are final for the drawer (only a manual,
-- attested completion settles such a claim). The same machine as 0040's return payouts.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_payout_claims_kick_guard
BEFORE UPDATE OF kick_outcome, kick_count, kicked_at ON sale_void_payout_claims
WHEN NOT (
  (NEW.kick_outcome IS OLD.kick_outcome AND NEW.kick_count = OLD.kick_count
    AND NEW.kicked_at IS OLD.kicked_at)
  OR ((OLD.kick_outcome IS NULL OR OLD.kick_outcome = 'failed_before_send')
    AND NEW.kick_outcome = 'sending' AND NEW.kick_count = OLD.kick_count + 1
    AND NEW.kicked_at IS NOT NULL)
  OR (OLD.kick_outcome = 'sending'
    AND NEW.kick_outcome IN ('opened', 'failed_before_send', 'unknown')
    AND NEW.kick_count = OLD.kick_count AND NEW.kicked_at IS OLD.kicked_at)
)
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payout_claims: illegal drawer kick transition (RT-1403)');
END;

CREATE TRIGGER IF NOT EXISTS trg_sale_void_payout_claims_no_delete
BEFORE DELETE ON sale_void_payout_claims
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payout_claims is append-only: DELETE is denied (RT-1403)');
END;

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

  -- An exception is always a manual, attested record.
  CHECK (kind <> 'exception' OR method = 'manual'),
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

-- A payout needs a confirmed void, paid on the void's own business day (`business_date` is the day of
-- `paid_at`), in the shift that was already open when the void was requested. (Checked once the void
-- and the shift rows exist; their own triggers answer otherwise.)
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

-- A payout completes its CLAIM, in the claim's shift; whatever record settles a claim needs a drawer that
-- is not mid-kick. A `drawer` record follows a kick that opened, a `no_drawer` record one that provably
-- never reached the hardware. A kick still `sending` within the lease (10 s = 2 x the 5 s drawer timeout)
-- holds the claim, measured against the record's own `paid_at`, bounded on both sides, as in 0040.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_payouts_claim
BEFORE INSERT ON sale_void_payouts
WHEN (NEW.kind = 'payout' AND NOT EXISTS (
    SELECT 1 FROM sale_void_payout_claims c
     WHERE c.void_id = NEW.void_id AND c.shift_id = NEW.shift_id
  ))
  OR EXISTS (
    SELECT 1 FROM sale_void_payout_claims c
     WHERE c.void_id = NEW.void_id AND (
       (NEW.method = 'drawer' AND c.kick_outcome IS NOT 'opened')
       OR (NEW.method = 'no_drawer' AND c.kick_outcome IS NOT 'failed_before_send')
       OR (c.kick_outcome = 'sending'
         AND CAST(ROUND((julianday(NEW.paid_at) - julianday(c.kicked_at)) * 86400000.0) AS INTEGER)
           BETWEEN -10000 AND 9999)
     )
  )
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payouts: a payout needs its claim in the same shift and a drawer that is not mid-kick (claim, RT-1403)');
END;

-- An exception cites a real, spent RT-114 approval of kind `sale.void_cash_exception` that covers THIS
-- void on this terminal, bound to THIS cash amount and policy, granted to THIS requester by THIS
-- approver. 0048 stores `approval_id` in lower case (a CHECK), so it is compared directly and the
-- primary-key index is used; an upper-case id in the evidence simply finds no approval.
CREATE TRIGGER IF NOT EXISTS trg_sale_void_payouts_exception_approval
BEFORE INSERT ON sale_void_payouts
WHEN NEW.kind = 'exception' AND NOT EXISTS (
  SELECT 1 FROM manager_approvals a
   WHERE a.approval_id = NEW.exception_approval_id
     AND a.action_kind = 'sale.void_cash_exception'
     AND a.subject_ref = NEW.void_id
     AND a.tenant_id = NEW.tenant_id AND a.branch_id = NEW.branch_id
     AND a.terminal_id = NEW.terminal_id
     AND a.amount_minor = NEW.amount_minor
     AND a.policy_version = NEW.exception_policy_version
     AND lower(a.requester_user_id) = lower(NEW.exception_requester_user_id)
     AND lower(a.approver_user_id) = lower(NEW.exception_approver_user_id)
     AND a.consumed_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'sale_void_payouts: an exception needs a spent approval of this kind, for this void and approver (approval, RT-1403)');
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
