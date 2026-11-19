-- RT-1490 — the queue of unrecognised scanned barcodes reported to Backend-Core.
--
-- [GATED: migration] approval: RT-1490 comment 17782 (the owner approved the
-- recommended Option A of comment 17780 directly in the executing session,
-- 2026-11-19; the lead recorded the same decision in comment 17781). It
-- approves this POS SQLite migration: one additive `unknown_item_captures`
-- table and its due-row index. No Backend-Core change, no contract change.
--
-- ## Why
--
-- A scan that the local catalogue does not know shows the inline notice and
-- nothing else, so the Console review queue (RT-724, RT-1018) never hears of
-- it. The POS now reports such a barcode to Backend-Core `posCaptureItem`
-- (`POST /api/pos/v1/catalog/unknown-items`). The report is fire-and-forget:
-- it never blocks or delays the sale, and it must survive being offline and a
-- restart. No existing outbox can carry it (each one belongs to one domain),
-- hence this table.
--
-- ## Shape
--
--   capture_id        UUIDv7 minted at enqueue; also the `Idempotency-Key`, so
--                     every resend of a row is the same logical request
--   tenant_id, branch_id, terminal_id
--                     the pairing the scan happened under; only the current
--                     pairing's rows are sent (as the audit and sale outboxes)
--   barcode           the scanned code, 1..200 characters (the contract's
--                     `identifier_value` bounds); catalogue reference data, not PII
--   capture_day       the store business day (YYYY-MM-DD) of the scan
--   state             'pending' → 'sent' (2xx) or 'refused' (a final 4xx)
--   attempts, next_attempt_at, last_status
--                     the per-row retry state (bounded exponential backoff)
--   enqueued_at, settled_at
--
-- UNIQUE (tenant_id, branch_id, barcode, capture_day) is the client cap: one
-- report per barcode per store per day. A rescan the same day is a no-op
-- (INSERT OR IGNORE), so it also collapses into the day's one request.
--
-- ## §A2 migration safety
--
--   • Additive only: one new table and one index, IF NOT EXISTS, shipped empty.
--     No existing table, column, index or trigger is touched; no backfill.
--   • The runner applies it in its per-file transaction, after the RT-320
--     pre-migration snapshot of the live database.
--
-- ## Rollback (manual, not run by the app)
--
-- Downgrades are unsupported: a pre-0064 build refuses a database that lists
-- 0064 as applied (`SchemaAheadError`, RT-320). The queue is disposable: at
-- worst unsent reports are lost, and the sale is never affected.
--
--   DROP INDEX idx_unknown_item_captures_due;
--   DROP TABLE unknown_item_captures;

CREATE TABLE IF NOT EXISTS unknown_item_captures (
  capture_id       TEXT    NOT NULL PRIMARY KEY CHECK (length(capture_id) = 36),
  tenant_id        TEXT    NOT NULL CHECK (length(tenant_id) > 0),
  branch_id        TEXT    NOT NULL CHECK (length(branch_id) > 0),
  terminal_id      TEXT    NOT NULL CHECK (length(terminal_id) > 0),
  barcode          TEXT    NOT NULL CHECK (length(barcode) BETWEEN 1 AND 200),
  capture_day      TEXT    NOT NULL CHECK (
    capture_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
  ),
  state            TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending', 'sent', 'refused')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TEXT    NOT NULL,
  last_status      INTEGER,
  enqueued_at      TEXT    NOT NULL,
  settled_at       TEXT,
  UNIQUE (tenant_id, branch_id, barcode, capture_day)
);

CREATE INDEX IF NOT EXISTS idx_unknown_item_captures_due
  ON unknown_item_captures (tenant_id, branch_id, terminal_id, state, next_attempt_at);
