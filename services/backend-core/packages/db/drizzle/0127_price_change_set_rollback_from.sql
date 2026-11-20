-- 0127_price_change_set_rollback_from -- Jira RT-1532 (RT-1484 follow-up). `[GATED: migration]`.
-- DDL only; the backfill is 0128 (its own transaction).
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
-- The guard trigger (0121 `change_sets_guard`) is replaced (the 0112 precedent) so the pair is a creation fact:
--   * once either column is non-NULL, no UPDATE may change either (the pair is immutable);
--   * the ONLY change allowed to the pair in ANY state is NULL -> value of both, with every other column unchanged.
--     That is what the 0128 backfill does to a published, superseded or cancelled set, which the guard otherwise refuses
--     any change to. It is checked before the state rules and returns early, so it opens nothing else.
-- The rest of the body is the 0121 body unchanged (0127's down restores it exactly). The `change_sets_set_updated_at`
-- trigger is left as it is: the backfill's UPDATE moves `updated_at` of each set it fills once (accepted: smaller than
-- teaching that trigger to skip a column change, and a set is filled at most once).
--
-- Grants: none. The domain role holds table-level INSERT on change_sets (the new columns are writable at create) and
-- column-level UPDATE on a fixed column list that does not name them, so the application can never change them after
-- create (docs/operations/sql/pricing-domain-grants.sql is unchanged); the guard is the second line.
--
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on change_sets; ADD COLUMN is catalog-only and each ADD CONSTRAINT scans the
-- table once (a tiny table: only Change Sets of the pricing authoring surface).
-- Rollback: 0127_price_change_set_rollback_from.down.sql (restores the 0121 guard body, then drops the constraints and
-- columns). Run 0128's down first (it drops the backfill function).

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

CREATE OR REPLACE FUNCTION change_sets_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.domain <> OLD.domain OR NEW.kind <> OLD.kind
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at
     OR NEW.rolls_back_change_set_id IS DISTINCT FROM OLD.rolls_back_change_set_id THEN
    RAISE EXCEPTION 'change set %: identity, kind and creation facts never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- RT-1532: the rollback start is a creation fact, set once. In any state the only change to it is NULL -> value (of
  -- both columns) with nothing else changing (the 0128 backfill); once set, neither column changes.
  IF NEW.rollback_from IS DISTINCT FROM OLD.rollback_from
     OR NEW.rollback_from_defaulted IS DISTINCT FROM OLD.rollback_from_defaulted THEN
    IF OLD.rollback_from IS NOT NULL OR OLD.rollback_from_defaulted IS NOT NULL
       OR (to_jsonb(NEW) - 'rollback_from' - 'rollback_from_defaulted' - 'updated_at')
          IS DISTINCT FROM (to_jsonb(OLD) - 'rollback_from' - 'rollback_from_defaulted' - 'updated_at') THEN
      RAISE EXCEPTION 'change set %: the rollback start is set once, by itself, and never changes', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('cancelled', 'superseded', 'rolled_back') THEN
    RAISE EXCEPTION 'change set % is % and never changes', OLD.id, OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'change set %: the version only moves forward', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revision_no IS NOT NULL AND NEW.revision_no IS DISTINCT FROM OLD.revision_no THEN
    RAISE EXCEPTION 'change set %: the published revision is set once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- A published set changes only to its derived superseded / rolled_back state.
  IF OLD.state = 'published' THEN
    IF NEW.state NOT IN ('published', 'superseded', 'rolled_back')
       OR (to_jsonb(NEW) - 'state' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'updated_at') THEN
      RAISE EXCEPTION 'change set % is published: only its superseded / rolled_back state may change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

COMMIT;
