-- 0128_price_change_set_rollback_from_backfill -- Jira RT-1532 (RT-1484 follow-up). `[GATED: migration]`.
-- Data only (plus the function that does it); the columns, constraints and guard are 0127 (the 0112 / 0113 split).
--
-- Fills `change_sets.rollback_from` and `rollback_from_defaulted` of every `kind = 'rollback'` set whose columns are
-- still NULL from its own FIRST `pricing.change_set.created` audit row (metadata `rollback_from`,
-- `rollback_from_defaulted`; the row `validate` read before RT-1532). Per set:
--   * the first `created` row has a `rollback_from` that is an ISO-8601 timestamp PostgreSQL can cast: both columns are
--     set (a missing or non-true `rollback_from_defaulted` is false, the explicit case);
--   * otherwise (no audit row, no `rollback_from`, a value that is not ISO-8601 or that does not cast, such as
--     2026-02-30 or an offset of +20:00) the set is left NULL: validate refuses it with 409 change_set_invalid_state
--     ("cancel and recreate the rollback"), exactly what it did when the audit row could not be read back. Nothing is
--     guessed, and a bad value never fails the migration (the cast sits behind pg_input_is_valid, PostgreSQL 16+, the
--     minimum this repo runs and tests on).
--
-- The work is the function `price_change_set_backfill_rollback_from()`, called once here. It is idempotent (only a
-- rollback set with both columns NULL is touched, so a second call returns 0). The API that runs while `migrate` runs
-- may still create rollback sets without the columns, so the deploy re-runs it once the new API is up, as the
-- migration owner (README Deploy step 4, docs/operations/sql/price-change-set-rollback-from-catchup.sql):
--     SELECT price_change_set_backfill_rollback_from();
-- (it returns the number of sets filled; 0 means nothing was left).
--
-- FORCE RLS: change_sets and audit_events are FORCE ROW LEVEL SECURITY with tenant-GUC policies and the migration
-- owner is NOSUPERUSER, so a plain statement sees no row. The function sets app.is_platform_admin, pins
-- app.current_tenant to the nil UUID before it reads `tenants`, then sets the tenant GUC per tenant and carries an
-- explicit `tenant_id = t` predicate on every statement. FORCE RLS is never lifted.
--
-- Guard: change_sets_guard refuses any change to a published, superseded, rolled-back or cancelled set, except the
-- one NULL -> value fill of exactly these two columns that 0127 allows in any state, so this is a plain UPDATE: no
-- trigger is disabled. The fill moves `updated_at` of each set once (the set_updated_at trigger runs; accepted, see 0127).
--
-- Rollback: 0128_price_change_set_rollback_from_backfill.down.sql drops the function (the filled values go with 0127's
-- columns; the audit rows still hold them).

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION price_change_set_backfill_rollback_from() RETURNS integer
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The sets one tenant can still be filled for, with what its first `created` audit row says. $1 = tenant.
  -- The cast is inside a CASE behind the shape check and pg_input_is_valid, so it is never evaluated on a bad value
  -- whatever order the planner picks.
  candidates CONSTANT text := $q$
    SELECT s.id, s.from_at, s.defaulted
      FROM (
        SELECT cs.id,
               CASE WHEN jsonb_typeof(a.metadata -> 'rollback_from') = 'string'
                         AND (a.metadata ->> 'rollback_from') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
                         AND pg_input_is_valid(a.metadata ->> 'rollback_from', 'timestamptz')
                    THEN (a.metadata ->> 'rollback_from')::timestamptz END AS from_at,
               COALESCE((a.metadata -> 'rollback_from_defaulted') = 'true'::jsonb, false) AS defaulted
          FROM change_sets cs
         CROSS JOIN LATERAL (
           SELECT ae.metadata
             FROM audit_events ae
            WHERE ae.tenant_id = $1
              AND ae.action = 'pricing.change_set.created'
              AND ae.target_type = 'price_change_set'
              AND ae.target_id = cs.id
            ORDER BY ae.occurred_at, ae.id
            LIMIT 1) a
         WHERE cs.tenant_id = $1
           AND cs.kind = 'rollback'
           AND cs.rollback_from IS NULL
           AND cs.rollback_from_defaulted IS NULL) s
     WHERE s.from_at IS NOT NULL
  $q$;
  t uuid;
  n bigint;
  filled bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE format(
      'WITH src AS (%s)
       UPDATE change_sets cs
          SET rollback_from = src.from_at, rollback_from_defaulted = src.defaulted
         FROM src
        WHERE cs.tenant_id = $1 AND cs.id = src.id
          AND cs.rollback_from IS NULL AND cs.rollback_from_defaulted IS NULL', candidates) USING t;
    GET DIAGNOSTICS n = ROW_COUNT;
    filled := filled + n;
  END LOOP;
  RETURN filled::integer;
END
$$;

REVOKE ALL ON FUNCTION price_change_set_backfill_rollback_from() FROM PUBLIC;

SELECT price_change_set_backfill_rollback_from();

COMMIT;
