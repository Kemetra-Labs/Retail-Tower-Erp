-- 0128_price_change_set_rollback_from_backfill -- Jira RT-1532 (RT-1484 follow-up). `[GATED: migration]`.
-- Data only (plus the function that does it); the columns and constraints are 0127 (the 0112 / 0113 split).
--
-- Fills `change_sets.rollback_from` and `rollback_from_defaulted` of every `kind = 'rollback'` set whose columns are
-- still NULL from its own FIRST `pricing.change_set.created` audit row (metadata `rollback_from`,
-- `rollback_from_defaulted`; the row `validate` read before RT-1532). Per set:
--   * the first `created` row has a `rollback_from` that is an ISO-8601 timestamp: both columns are set (a missing or
--     non-true `rollback_from_defaulted` is false, the explicit case);
--   * otherwise (no audit row, no `rollback_from`, or an unparseable value) the set is left NULL: validate refuses it
--     with 409 change_set_invalid_state ("cancel and recreate the rollback"), exactly what it did when the audit
--     row could not be read back. Nothing is guessed.
--
-- The work is the function `price_change_set_backfill_rollback_from()`, called once here. It is idempotent (only a
-- rollback set with both columns NULL is touched, so a second call returns 0) and cheap when nothing is left (it
-- looks first and takes no table lock then). The API that runs while `migrate` runs may still create rollback sets
-- without the columns, so the deploy re-runs it once the new API is up, as the migration owner:
--     SELECT price_change_set_backfill_rollback_from();
-- (it returns the number of sets filled; 0 means nothing was left).
--
-- FORCE RLS: change_sets and audit_events are FORCE ROW LEVEL SECURITY with tenant-GUC policies and the migration
-- owner is NOSUPERUSER, so a plain statement sees no row. The function sets app.is_platform_admin, pins
-- app.current_tenant to the nil UUID before it reads `tenants`, then sets the tenant GUC per tenant and carries an
-- explicit `tenant_id = t` predicate on every statement. FORCE RLS is never lifted.
--
-- Triggers: change_sets_guard refuses ANY change to a published, superseded, rolled-back or cancelled set, and
-- change_sets_set_updated_at would move `updated_at` of every set it fills. A backfill of a terminal rollback set's
-- provenance is not a lifecycle change, so the function disables exactly those two triggers around its UPDATEs
-- and enables them again before it returns, in the caller's transaction (ALTER TABLE DISABLE TRIGGER is transactional,
-- and it holds SHARE ROW EXCLUSIVE until commit, which excludes every concurrent writer of change_sets, so no
-- other write can slip through while they are off). It runs only when there is something to fill. The remaining
-- change_sets triggers (content rules, publish-complete) are left on: a same-state update passes them. The deferred
-- publish-complete events are run with SET CONSTRAINTS ... IMMEDIATE before the triggers are enabled again (ALTER TABLE
-- refuses a table with pending trigger events).
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
  candidates CONSTANT text := $q$
    SELECT cs.id,
           (a.metadata ->> 'rollback_from')::timestamptz AS from_at,
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
       AND cs.rollback_from_defaulted IS NULL
       AND jsonb_typeof(a.metadata -> 'rollback_from') = 'string'
       AND (a.metadata ->> 'rollback_from') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  $q$;
  t uuid;
  n bigint;
  pending bigint := 0;
  filled bigint := 0;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE format('SELECT count(*) FROM (%s) c', candidates) INTO n USING t;
    pending := pending + n;
  END LOOP;
  IF pending = 0 THEN
    RETURN 0;
  END IF;
  ALTER TABLE change_sets DISABLE TRIGGER change_sets_guard;
  ALTER TABLE change_sets DISABLE TRIGGER change_sets_set_updated_at;
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    EXECUTE format(
      'WITH src AS (%s)
       UPDATE change_sets cs
          SET rollback_from = src.from_at, rollback_from_defaulted = src.defaulted
         FROM src
        WHERE cs.tenant_id = $1 AND cs.id = src.id', candidates) USING t;
    GET DIAGNOSTICS n = ROW_COUNT;
    filled := filled + n;
  END LOOP;
  -- change_sets_publish_complete is a deferred constraint trigger: its events (one per updated row, a no-op for a set
  -- whose state did not change) must run before ALTER TABLE may enable a trigger again.
  SET CONSTRAINTS change_sets_publish_complete IMMEDIATE;
  ALTER TABLE change_sets ENABLE TRIGGER change_sets_set_updated_at;
  ALTER TABLE change_sets ENABLE TRIGGER change_sets_guard;
  RETURN filled::integer;
END
$$;

REVOKE ALL ON FUNCTION price_change_set_backfill_rollback_from() FROM PUBLIC;

SELECT price_change_set_backfill_rollback_from();

COMMIT;
