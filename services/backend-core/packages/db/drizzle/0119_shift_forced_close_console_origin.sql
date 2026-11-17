-- 0119_shift_forced_close_console_origin.sql
--
-- A Console force close of a stuck shift has no closing terminal (Jira RT-1445,
-- slice B1 of RT-1437; contract `console-force-actions.openapi.yaml`
-- 1.0.0-draft, RT-1444, PR #641). [GATED] migration: owner decision
-- 2026-11-17 on RT-1445 (comment 17340): record a Console close honestly with
-- `closed_via`, option (a). The decision record is Confluence RETAIL page
-- 80084994 (D5, second part).
--
-- Why: `shift_forced_closes.closed_from_device_id` (0070) is NOT NULL with a
-- composite foreign key to `devices`. A close made from the owner's Console
-- came from no terminal, and `closedFromTerminalLabel: null` already means "that
-- terminal has no label", so neither a NULL label nor a placeholder device can
-- say "Console". The fact therefore records where the close came from.
--
-- Changes (additive; every existing row is a POS close and stays valid):
--   1. closed_from_device_id becomes nullable. The composite FK
--      `fk_shift_forced_closes_closed_from_device` (closed_from_device_id,
--      tenant_id, store_id) is MATCH SIMPLE, so with a NULL device it is not
--      checked, and with a device it still pins the terminal to the shift's
--      tenant and store, exactly as before. It is kept as it is.
--   2. closed_via TEXT NOT NULL DEFAULT 'pos', CHECK IN ('pos', 'console'). A
--      constant default is a catalog change only (PG 11+): no table rewrite, and
--      every existing row reads 'pos'. No backfill is needed.
--   3. CHECK ((closed_via = 'console') = (closed_from_device_id IS NULL)): a
--      Console close has no terminal, and a POS close always has one. Both
--      directions are enforced, so a POS close cannot lose its terminal.
--
-- No grant change: the table stays SELECT + INSERT only for the domain role
-- (docs/operations/sql/shift-forced-closes-domain-grants.sql); table-level
-- grants cover the new column. No RLS, trigger or policy change: the policies
-- and the append-only and require-open-shift triggers read none of these
-- columns. No `shifts` change, so shifts_cash_up_guard is untouched.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): unchanged, FINANCIAL-
-- OPERATIONAL class. `closed_via` is a two-value code, no PII.
--
-- Lock impact: ONE transaction; the locks are held until COMMIT.
--   - shift_forced_closes: ACCESS EXCLUSIVE (ALTER TABLE). One row per
--     force-closed shift, so the table is tiny; the CHECKs scan it once. Only
--     force-close reads and writes wait, and a closeShift or cash-up re-delivery
--     reads this table to learn whether a shift was force-closed, so they wait
--     too, for well under a second.
--   - tenants, stores: none (no FK is added).
-- lock_timeout = 2s per lock request (the 0047 rule): if the lock cannot be
-- taken in time the migration fails and rolls back instead of queueing an
-- ACCESS EXCLUSIVE request that blocks traffic behind it; re-run it.
-- Forward-only in production. Reversible in a test via
-- 0119_shift_forced_close_console_origin.down.sql (refused while any Console
-- close is recorded).

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE shift_forced_closes
  ALTER COLUMN closed_from_device_id DROP NOT NULL;

ALTER TABLE shift_forced_closes
  ADD COLUMN closed_via TEXT NOT NULL DEFAULT 'pos';

ALTER TABLE shift_forced_closes
  ADD CONSTRAINT shift_forced_closes_closed_via_values
    CHECK (closed_via IN ('pos', 'console'));

ALTER TABLE shift_forced_closes
  ADD CONSTRAINT shift_forced_closes_closed_via_device
    CHECK ((closed_via = 'console') = (closed_from_device_id IS NULL));

COMMIT;
