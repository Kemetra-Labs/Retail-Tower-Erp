-- RT-886 (RT-839 S1) — the terminal's receipt printer choice.
--
-- [GATED] approval: the owner authorised ONE new local POS migration for this
-- setting in Jira RT-839 comment 13968 (Q3, 2026-10-26: "one new local POS
-- SQLite migration is authorized. It holds the per-terminal printer setting in
-- a single-row table (D1a). It needs no Backend-Core contract."), carried by
-- RT-886. 0057 is the next free number.
--
-- ## Why
--
-- The POS prints receipts, return slips and reprints through the Windows OS
-- print path. No printer was ever named, so Windows used its default printer,
-- often a paper printer instead of the thermal one (rt9 lab, 2026-10-23). Any
-- signed-in operator may now pick an installed printer, or «Windows default».
--
-- ## Shape
--
-- One row at most (`id = 1`): the printer belongs to this computer, not to a
-- pairing or an operator.
--
--   printer_source          'chosen' (the named queue) or 'os_default'
--   printer_name            the exact Windows queue name; set iff 'chosen'
--   updated_at              ISO-8601 UTC of the last change
--   updated_by_operator_id  the operator who made it (also in the audit event)
--
-- No row means no printer was chosen yet: prints keep going to the Windows
-- default and the Sale screen offers the choice once (non-blocking).
--
-- It is a table of its own, not a pairing column: a re-pair rewrites the
-- pairing row (`INSERT OR REPLACE`, pairing/store.ts), which would wipe it.
-- Nothing here is sent to Backend-Core.
--
-- ## §A2 migration safety
--
--   • Additive only: one new table, IF NOT EXISTS, shipped empty. No existing
--     table, column, index or trigger is touched; no backfill.
--   • The CHECKs bind the name to the source, so a half-written choice cannot
--     be stored.
--   • The runner applies it in its per-file transaction, after the RT-320
--     pre-migration snapshot of the live database.
--
-- ## Rollback
--
-- Downgrades are unsupported. A pre-0057 build refuses a database that lists
-- 0057 as applied (`SchemaAheadError`, RT-320), so dropping the table is not a
-- production downgrade path. To recover, re-run the current release. The
-- RT-320 pre-migration snapshot taken before 0057 is for support-assisted
-- recovery only; restoring it discards everything recorded after it.

CREATE TABLE IF NOT EXISTS terminal_printer_setting (
  id                      INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  printer_source          TEXT    NOT NULL CHECK (printer_source IN ('chosen', 'os_default')),
  printer_name            TEXT,
  updated_at              TEXT    NOT NULL,
  updated_by_operator_id  TEXT    NOT NULL CHECK (length(updated_by_operator_id) > 0),
  CHECK (
    (printer_source = 'chosen'
      AND printer_name IS NOT NULL
      AND length(printer_name) BETWEEN 1 AND 256)
    OR (printer_source = 'os_default' AND printer_name IS NULL)
  )
);
