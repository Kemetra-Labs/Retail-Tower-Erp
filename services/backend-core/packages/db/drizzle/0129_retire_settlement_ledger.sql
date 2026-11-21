-- 0129_retire_settlement_ledger -- Jira RT-422 (RT-413 Option B, final step). `[GATED: migration]`.
--
-- Drops the six spec-035 A/R ledger tables 0027 created: receivable,
-- payment_application, claim, claim_receivables, remittance, reconciliation_result.
-- ERPNext owns customer and third-party A/R (RT-413); no runtime reads or writes
-- these tables any more (the runtime is removed in the same change).
--
-- Owner [GATED] authorization: Jira RT-422 comment 18024 (2026-11-21), conditional
-- on a clean row count. RT-416 (comments 13219 and 18027) found all seven spec-035
-- tables empty on the lab database; no staging or production database exists.
--
-- KEPT: payer_account (the payer facade, RT-418) and every table that references it
-- (sale_responsibilities, sale_credit_reversals). Nothing here touches them.
--
-- PRE-DROP GUARD: the migration refuses, and changes nothing, if any of the six
-- tables holds a row in any tenant. The six tables are FORCE ROW LEVEL SECURITY and
-- their policies match only app.current_tenant, so a plain count would read 0 as the
-- NOSUPERUSER migration owner. The guard therefore walks the tenants (the 0043
-- pattern: tenants are read under app.is_platform_admin, app.current_tenant is set
-- per tenant, every count carries an explicit tenant predicate) and never lifts
-- FORCE on any table. The message names the table and the count only, never a row.
-- A row whose tenant_id has no tenants row cannot exist (tenant_id is a NOT NULL
-- foreign key to tenants).
--
-- The tables are locked first (ACCESS EXCLUSIVE, children before parents) so a write
-- from the previous API version, which may still run while `migrate` runs, cannot
-- land between the count and the drop. Dropped without CASCADE, children first, so an
-- unexpected dependency fails the migration loudly instead of dropping something else.
--
-- Rollback: 0129_retire_settlement_ledger.down.sql recreates the six tables, empty,
-- from the 0027 definitions. 0027.down is never applied to live data.

BEGIN;

LOCK TABLE reconciliation_result, remittance, claim_receivables, payment_application, claim, receivable
  IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  t uuid;
  tbl text;
  n bigint;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    FOREACH tbl IN ARRAY ARRAY[
      'reconciliation_result', 'remittance', 'claim_receivables',
      'payment_application', 'claim', 'receivable'
    ] LOOP
      EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', tbl) INTO n USING t;
      IF n > 0 THEN
        RAISE EXCEPTION
          'RT-422: refusing to drop the spec-035 A/R ledger: % holds % row(s) for a tenant; dispose of the data first',
          tbl, n
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END LOOP;
END
$$;

DROP TABLE reconciliation_result;
DROP TABLE remittance;
DROP TABLE claim_receivables;
DROP TABLE payment_application;
DROP TABLE claim;
DROP TABLE receivable;

COMMIT;
