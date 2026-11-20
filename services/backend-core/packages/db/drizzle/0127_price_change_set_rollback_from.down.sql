-- 0127_price_change_set_rollback_from.down.sql (RT-1532): restore the 0121 `change_sets_guard` body, then drop the two
-- CHECK constraints and the two columns (the guard first: the new body names the columns).
--
-- Nothing is lost: the same two facts are still recorded in each rollback set's `pricing.change_set.created` audit row
-- (the create keeps writing them), which is where the code before this migration reads them. Rerunnable.
-- 0128's down (the backfill function) runs first in a full-chain down.

BEGIN;

SET LOCAL lock_timeout = '2s';

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

ALTER TABLE change_sets DROP CONSTRAINT IF EXISTS change_sets_rollback_from_whole;
ALTER TABLE change_sets DROP CONSTRAINT IF EXISTS change_sets_rollback_from_kind;
ALTER TABLE change_sets DROP COLUMN IF EXISTS rollback_from_defaulted;
ALTER TABLE change_sets DROP COLUMN IF EXISTS rollback_from;

COMMIT;
