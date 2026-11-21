-- RT-1543 — the refund-execution outbox: report each completed cash payout to Backend-Core.
--
-- [GATED] approval: the owner decided in chat on 2026-11-21 (RT-1543 comments 18082 and 18114)
-- that the till reports every completed return payout with `recordRefundExecution`, and approved a
-- GATED POS local migration if one is needed. A durable outbox is needed: the report must survive a
-- crash, an unknown answer and a restart, and must be sent once.
--
-- Numbering: main holds 0066. Open PR #791 (RT-388) is taking 0067; this file is 0068 on purpose.
-- The runner applies pending files by NAME (not by position), so a till that gets 0068 first applies
-- 0067 in a later build without error. Neither file touches the other's table.
--
-- ## Why
--
-- Backend-Core (RT-787, F-2) records that an allocation of an accepted return was paid out through
-- `POST /api/pos/v1/sales/{saleRef}/returns/{returnRef}/executions`. With the settle-before-post
-- deploy flag on, a return posts to the ERP only once its executions settle it, so a till that never
-- reports one strands the return. The POS pays out after the return is confirmed (0040) and reports
-- the payout here.
--
-- ## Shape (one row per allocation of a paid-out return)
--
--   execution_id     the execution's own identity (`executionRef`, UUIDv7), minted at enqueue
--   return_id        the journaled return (0039); the return must be `paid_out` to insert
--   server_sale_ref  the sale's server ref, copied so a send needs no join
--   return_ref       the server's ref of the return (set when the return was confirmed)
--   allocation_ref   the allocation paid out: an `allocationRef` of that return's stored body
--   external_id      `pos-pulse-refund-exec:<execution_id>`: the provenance id and the Idempotency-Key
--   request_body_json the exact `RecordRefundExecutionRequest` bytes, frozen at enqueue; every
--                     retry sends these bytes under that key
--   state            pending (never answered) | unknown (answer lost) | recorded | refused
--   refusal_reason   why a `refused` row was refused (a closed code); only with `refused`
--   attempt_count, last_attempt_at   the resolver's backoff anchor
--   recorded_at      when Backend-Core confirmed it; only with `recorded`
--
-- `recorded` and `refused` are final. A row is never deleted. Identity columns and the frozen body
-- never change. One row per (return, allocation), and one per external id: the payout of one
-- allocation is reported once, however often the till retries or restarts.
--
-- ## §A2 migration safety
--
--   • Additive only: one new table and three triggers on it; no existing table, column,
--     constraint, index or trigger is altered or dropped.
--   • Ships empty, so no CHECK can fail on an existing database. No backfill: a return paid out
--     before this build carries no allocation ref in its stored body (those bytes are never
--     rewritten) and has nothing to report.
--   • Code before 0068 never names the table. A build without 0068 refuses this database
--     (`SchemaAheadError`, RT-320), so the only way back is forward.
--   • The runner applies it in its per-file transaction, after the RT-320 pre-migration snapshot.
--
-- ## Rollback
--
-- Downgrades are unsupported (RT-320). By hand, on a stopped terminal, after every row is
-- `recorded` or `refused`:
--   DROP TRIGGER IF EXISTS trg_return_refund_executions_paid_out_only;
--   DROP TRIGGER IF EXISTS trg_return_refund_executions_guard;
--   DROP TRIGGER IF EXISTS trg_return_refund_executions_no_delete;
--   DROP TABLE IF EXISTS return_refund_executions;
-- Dropping it with a `pending` or `unknown` row loses a payout that Backend-Core was never told of.

CREATE TABLE IF NOT EXISTS return_refund_executions (
  execution_id       TEXT    NOT NULL PRIMARY KEY CHECK (
    length(execution_id) = 36
    AND execution_id NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(execution_id, '-', '')) = 32
  ),
  return_id          TEXT    NOT NULL,
  server_sale_ref    TEXT    NOT NULL CHECK (
    length(server_sale_ref) = 36
    AND server_sale_ref NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(server_sale_ref, '-', '')) = 32
  ),
  return_ref         TEXT    NOT NULL CHECK (
    length(return_ref) = 36
    AND return_ref NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(return_ref, '-', '')) = 32
  ),
  allocation_ref     TEXT    NOT NULL CHECK (
    length(allocation_ref) = 36
    AND allocation_ref NOT GLOB '*[^0-9A-Fa-f-]*'
    AND length(replace(allocation_ref, '-', '')) = 32
  ),
  external_id        TEXT    NOT NULL UNIQUE CHECK (
    external_id GLOB 'pos-pulse-refund-exec:*' AND length(external_id) = 58
  ),
  request_body_json  TEXT    NOT NULL CHECK (length(request_body_json) > 0),
  state              TEXT    NOT NULL CHECK (state IN ('pending', 'unknown', 'recorded', 'refused')),
  refusal_reason     TEXT    CHECK (refusal_reason IS NULL OR length(refusal_reason) > 0),
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at    TEXT,
  created_at         TEXT    NOT NULL CHECK (length(created_at) > 0),
  updated_at         TEXT    NOT NULL CHECK (length(updated_at) > 0),
  recorded_at        TEXT,
  UNIQUE (return_id, allocation_ref),
  FOREIGN KEY (return_id) REFERENCES return_journal(return_id),
  CHECK ((state = 'refused') = (refusal_reason IS NOT NULL)),
  CHECK ((state = 'recorded') = (recorded_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_return_refund_executions_open
  ON return_refund_executions (state, created_at)
  WHERE state IN ('pending', 'unknown');

-- An execution reports a payout that happened: the journal row must be `paid_out` (0040 moves it
-- only together with a completed payout row), and the row starts pending and never attempted.
CREATE TRIGGER IF NOT EXISTS trg_return_refund_executions_paid_out_only
BEFORE INSERT ON return_refund_executions
WHEN NOT EXISTS (
  SELECT 1 FROM return_journal j WHERE j.return_id = NEW.return_id AND j.state = 'paid_out'
)
OR NEW.state <> 'pending' OR NEW.attempt_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'return_refund_executions: only a pending row of a paid-out return may be inserted (RT-1543)');
END;

-- Identity and frozen body are immutable; `recorded` and `refused` are final; the state moves
-- forward only (pending -> pending | unknown | recorded | refused; unknown -> the same).
CREATE TRIGGER IF NOT EXISTS trg_return_refund_executions_guard
BEFORE UPDATE ON return_refund_executions
WHEN OLD.state IN ('recorded', 'refused')
  OR NEW.execution_id <> OLD.execution_id
  OR NEW.return_id <> OLD.return_id
  OR NEW.server_sale_ref <> OLD.server_sale_ref
  OR NEW.return_ref <> OLD.return_ref
  OR NEW.allocation_ref <> OLD.allocation_ref
  OR NEW.external_id <> OLD.external_id
  OR NEW.request_body_json <> OLD.request_body_json
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, CASE
    WHEN OLD.state IN ('recorded', 'refused')
      THEN 'return_refund_executions: a recorded or refused row is final (RT-1543)'
    ELSE 'return_refund_executions: identity columns and the frozen body are immutable (RT-1543)'
  END);
END;

CREATE TRIGGER IF NOT EXISTS trg_return_refund_executions_no_delete
BEFORE DELETE ON return_refund_executions
BEGIN
  SELECT RAISE(ABORT, 'return_refund_executions is append-only: DELETE is denied (RT-1543)');
END;
