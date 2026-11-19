-- RT-1312 Phase 3(c) — the till's local record of its sale-quarantine uploads.
--
-- [GATED: migration] approval: RT-1312 comment 17804 (the owner approved this
-- POS SQLite migration in chat on 2026-11-19: one additive table,
-- `sale_quarantine_upload`, and its due-row index `idx_sale_quarantine_upload_due`,
-- as proposed in comment 17803). Nothing else is covered. No Backend-Core change,
-- no contract change; the `POS_CONTRACT_REVISION` bump stays in slice B.
--
-- ## Why
--
-- A sale the till dead-lettered on a non-retryable 4xx, and a sale held
-- after a re-pair, are stranded on the till. Owner decision D1 (RT-1312): the
-- till uploads each such sale to Backend-Core (`posQuarantineSale`), which
-- keeps it for a Console repair. The till then marks its row quarantined and
-- stops counting it in the device heartbeat (decision P4). That mark, and the
-- per-row retry state of the upload, need a durable home:
--
--   • `sale_sync_state` cannot hold it for a held row (a held row may have no
--     state row at all), and its `last_error_category` is the reason the
--     heartbeat's `payloadDivergence` count reads, so it is not overloaded;
--   • `sale_sync_outbox` is append-only (008 AD-3) and is never written here.
--
-- ## Shape
--
--   sale_id           the sale; one row per sale (the primary key). The upload
--                     is naturally idempotent on the sale's provenance, so a
--                     re-send is always safe
--   tenant_id, branch_id
--                     the scope the sale belongs to (only the current tenant
--                     and branch are uploaded, decision P2)
--   state             'pending' (not uploaded yet; being retried)
--                     → 'uploaded' (200 / 201: Backend-Core holds it; the till
--                       stops counting the row and never uploads it again)
--                     or 'refused' (400 / 409 / 413 or another final 4xx: not
--                       retried automatically; the heartbeat counts keep
--                       showing the row)
--   attempts, next_attempt_at, last_status
--                     the per-row retry state (bounded exponential backoff;
--                     `Retry-After` honoured)
--   quarantine_ref, quarantine_state
--                     the receipt of a 200 / 201 (`QuarantineReceipt`); no sale
--                     facts, no money
--   created_at, updated_at, settled_at
--
-- ## §A2 migration safety
--
--   • Additive only: one new table and one index, IF NOT EXISTS, shipped empty.
--     No existing table, column, index or trigger is touched; no backfill.
--   • The uploader is inert until Backend-Core advertises the contract
--     revision that includes the upload, so the table stays empty until then.
--   • The runner applies it in its per-file transaction, after the RT-320
--     pre-migration snapshot of the live database.
--
-- ## Rollback (manual, not run by the app)
--
-- Downgrades are unsupported: a pre-0065 build refuses a database that lists
-- 0065 as applied (`SchemaAheadError`, RT-320). The table is a record of what
-- was uploaded; dropping it makes the till forget the marks, so the rows count
-- again in the heartbeat and are uploaded again (idempotent server-side).
--
--   DROP INDEX idx_sale_quarantine_upload_due;
--   DROP TABLE sale_quarantine_upload;

CREATE TABLE IF NOT EXISTS sale_quarantine_upload (
  sale_id          TEXT    NOT NULL PRIMARY KEY CHECK (length(sale_id) > 0),
  tenant_id        TEXT    NOT NULL CHECK (length(tenant_id) > 0),
  branch_id        TEXT    NOT NULL CHECK (length(branch_id) > 0),
  state            TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending', 'uploaded', 'refused')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TEXT    NOT NULL,
  last_status      INTEGER,
  quarantine_ref   TEXT,
  quarantine_state TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  settled_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_sale_quarantine_upload_due
  ON sale_quarantine_upload (tenant_id, branch_id, state, next_attempt_at);
