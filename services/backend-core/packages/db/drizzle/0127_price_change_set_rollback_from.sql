-- 0127_price_change_set_rollback_from -- Jira RT-1532 (RT-1484 follow-up). `[GATED: migration]`.
--
-- A rollback Change Set's requested start (`from`) lived only in its own `pricing.change_set.created` audit row, and
-- `validate` read it back from there (RT-1484 PR-6, owner decision 2026-11-20). Business logic must not depend on audit
-- rows (0004 anticipates a deletion-readiness sweep), so the two facts get columns on change_sets:
--
--   rollback_from            timestamptz NULL  the restore start the rollback was created with: the caller's explicit
--                                              `from`, or the creation instant when `from` was omitted ("at publish").
--   rollback_from_defaulted  boolean     NULL  true when `from` was omitted: validate then uses now, not rollback_from.
--
-- Two CHECK constraints, both valid for every existing row (every existing row has both columns NULL), so no NOT VALID
-- step and no table rewrite (a nullable column without a default is a catalog-only change):
--   change_sets_rollback_from_kind   only a `rollback` set carries either column;
--   change_sets_rollback_from_whole  the two are set together or not at all.
-- Deliberately NO constraint that a `rollback` set MUST carry them: the API that runs while `migrate` runs still creates
-- rollback sets without the columns, and a rollback set whose audit row cannot be read back (the backfill, 0128, leaves
-- it NULL) must stay cancellable; such a set is refused at validate (409 change_set_invalid_state), as before.
--
-- Grants: none. The domain role holds table-level INSERT on change_sets (the new columns are writable at create) and
-- column-level UPDATE on a fixed column list that does not name them, so the application can never change them after
-- create (docs/operations/sql/pricing-domain-grants.sql is unchanged).
--
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on change_sets; ADD COLUMN is catalog-only and each ADD CONSTRAINT scans the
-- table once (a tiny table: only Change Sets of the pricing authoring surface). The backfill is the next file (0128).
-- Rollback: 0127_price_change_set_rollback_from.down.sql.

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE change_sets
  ADD COLUMN rollback_from           TIMESTAMPTZ NULL,
  ADD COLUMN rollback_from_defaulted BOOLEAN     NULL;

ALTER TABLE change_sets
  ADD CONSTRAINT change_sets_rollback_from_kind CHECK (
    kind = 'rollback' OR (rollback_from IS NULL AND rollback_from_defaulted IS NULL)),
  ADD CONSTRAINT change_sets_rollback_from_whole CHECK (
    (rollback_from IS NULL) = (rollback_from_defaulted IS NULL));

COMMIT;
