-- 0130_shift_policy_flag_stale_at_receipt -- Jira RT-592 (RT-387 follow-up). `[GATED: migration]`.
-- Owner decision 2026-11-21: RT-592 comments 18021 (N = 24 h, flag name) and 18028 (the migration, in the same PR).
--
-- The open's accept-and-flag findings are stored in shifts.frozen_policy_flags (0050). Its CHECK
-- shifts_frozen_policy_flags_valid lists the three known flags, so the new fourth flag,
-- `policy_revision_stale_at_receipt` (pos-shifts 1.6.0-draft `PolicyFlag`), would be refused with 23514 and the
-- open would fail: the one thing a flag must never do. This migration widens the list.
--
-- The constraint is dropped and re-added with the same shape, the same "known flags only, each at most once, no
-- NULL element" rules and the new value. It is re-added NOT VALID, exactly as 0050 added it (and it was never
-- validated): every row it ever admitted already satisfies the wider rule (a superset), so a full-table scan under
-- ACCESS EXCLUSIVE on the hot shifts table would prove nothing. New and updated rows are checked against it.
-- DROP and ADD run in one transaction, so no write can slip between them.
--
-- DDL only: there is no data to move (no existing row can carry the new flag), so no backfill file.
-- Grants: none; no new column. No table rewrite.
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on shifts for the catalog change only (lock_timeout 2 s).
-- Rollback: 0130_shift_policy_flag_stale_at_receipt.down.sql (refuses while a shift carries the new flag).

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE shifts
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_flags_valid;

ALTER TABLE shifts
  ADD CONSTRAINT shifts_frozen_policy_flags_valid CHECK (
    frozen_policy_flags IS NULL
    OR (frozen_policy_flags <@ ARRAY['policy_revision_unknown', 'policy_revision_superseded',
                                     'policy_value_mismatch', 'policy_revision_stale_at_receipt']::text[]
        AND array_position(frozen_policy_flags, NULL) IS NULL
        AND cardinality(array_positions(frozen_policy_flags, 'policy_revision_unknown')) <= 1
        AND cardinality(array_positions(frozen_policy_flags, 'policy_revision_superseded')) <= 1
        AND cardinality(array_positions(frozen_policy_flags, 'policy_value_mismatch')) <= 1
        AND cardinality(array_positions(frozen_policy_flags, 'policy_revision_stale_at_receipt')) <= 1)) NOT VALID;

COMMIT;
