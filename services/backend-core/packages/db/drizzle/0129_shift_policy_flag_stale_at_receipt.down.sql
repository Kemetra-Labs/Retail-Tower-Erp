-- 0129_shift_policy_flag_stale_at_receipt.down.sql
--
-- RT-592 -- rollback for 0129_shift_policy_flag_stale_at_receipt.sql: restores the 0050 CHECK
-- shifts_frozen_policy_flags_valid (three known flags), NOT VALID as 0050 added it.
--
-- The rollback REFUSES while any shift carries `policy_revision_stale_at_receipt`: the flag is reporting
-- evidence that cannot be rebuilt, and a row that kept it would fail the restored CHECK the next time it is
-- updated (a close). A recorded open is immutable (the shifts_cash_up_guard trigger), so the cleanup is not
-- something this file does silently: back up, decide, and have a superuser strip the flag first (with the
-- shifts triggers disabled for the cleanup: ALTER TABLE shifts DISABLE TRIGGER USER).
--
-- shifts is FORCE ROW LEVEL SECURITY and the production migration owner is not a superuser, so the guard
-- reads under app.is_platform_admin with app.current_tenant pinned to the nil UUID (an unset or empty GUC
-- would fail the policy's uuid cast); a bare SELECT would see no rows and let the rollback through.
--
-- Rerunnable: the constraint is dropped IF EXISTS and re-added; running it twice changes nothing.
-- Supports the UP -> DOWN -> UP round trip exercised by
-- packages/db/__tests__/migration/0129-shift-policy-flag-stale-at-receipt.spec.ts and the full-chain down in
-- packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE shifts IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  SELECT count(*) INTO n
    FROM shifts
   WHERE frozen_policy_flags @> ARRAY['policy_revision_stale_at_receipt']::text[];
  IF n > 0 THEN
    RAISE EXCEPTION '0129 down refused: % shift(s) carry policy_revision_stale_at_receipt; the flag would be lost', n
      USING HINT = 'Back up the shifts, then strip the flag as a superuser with the shifts triggers disabled (ALTER TABLE shifts DISABLE TRIGGER USER).';
  END IF;
END
$$;

ALTER TABLE shifts
  DROP CONSTRAINT IF EXISTS shifts_frozen_policy_flags_valid;

ALTER TABLE shifts
  ADD CONSTRAINT shifts_frozen_policy_flags_valid CHECK (
    frozen_policy_flags IS NULL
    OR (frozen_policy_flags <@ ARRAY['policy_revision_unknown', 'policy_revision_superseded',
                                     'policy_value_mismatch']::text[]
        AND array_position(frozen_policy_flags, NULL) IS NULL
        AND cardinality(array_positions(frozen_policy_flags, 'policy_revision_unknown')) <= 1
        AND cardinality(array_positions(frozen_policy_flags, 'policy_revision_superseded')) <= 1
        AND cardinality(array_positions(frozen_policy_flags, 'policy_value_mismatch')) <= 1)) NOT VALID;

COMMIT;
