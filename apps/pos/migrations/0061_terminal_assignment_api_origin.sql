-- RT-1348 (RT-1345 S3, decision D3) — the pairing records the backend it was made against.
--
-- [GATED] approved: Jira RT-1348 scope item 1 ("a new POS migration"); decision
-- record RT-1345 D3, approved by the owner on 2026-11-12. Local POS database
-- only; no Backend-Core, contract or token-storage change.
--
-- Adds ONE nullable column, `api_origin`, to the single-row `terminal_assignment`
-- table (0003, extended by 0027 and 0042). Nothing else changes.
--
-- ## Why this migration exists
--
-- The pairing row held tenant, branch, terminal and `paired_at`, but not the
-- Backend-Core the terminal paired against. Starting the same installation
-- against another API address therefore sent the device token to a server that
-- never issued it; that server answers 401, and two device 401s mark the device
-- revoked (RT-215). With the origin on the row the terminal can tell "paired
-- with another server" from a real revocation, and never sends the token to the
-- other origin.
--
-- ## Semantics
--
--   • NULL     → a pairing made before this migration, or one made while the API
--                address could not be parsed. Such a row is never reported as
--                "another server"; it adopts the current origin on the first
--                successful device-authenticated call (a runtime step, not done
--                here: the migration cannot know which server a terminal is on).
--   • text     → the normalized origin (`scheme://host[:port]`, lower case, no
--                path, no default port) of the API the pairing was made on. Not a
--                secret.
--
-- A re-pair writes the row with `INSERT OR REPLACE`, which replaces the whole
-- row, so the column takes the origin of the new pairing.
--
-- ## Shape CHECK
--
-- NULL, or a non-empty TEXT value. SQLite tests an ADD COLUMN CHECK against
-- existing rows; every existing row gets NULL, which passes.
--
-- ## Re-apply protection
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`. Like 0027/0035/0038/0042 this file is
-- not file-level idempotent; the runner (`src/main/db/migrate.ts`) records it in
-- `schema_migrations` and never re-runs it. It runs inside the runner's default
-- per-file transaction.

ALTER TABLE terminal_assignment ADD COLUMN api_origin TEXT
  CHECK (
    api_origin IS NULL
    OR (typeof(api_origin) = 'text' AND length(api_origin) > 0)
  );
