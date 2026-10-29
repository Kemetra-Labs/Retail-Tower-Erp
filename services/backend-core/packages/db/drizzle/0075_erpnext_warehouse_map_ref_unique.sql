-- 0075_erpnext_warehouse_map_ref_unique.sql
--
-- One store per ERPNext Warehouse (Jira RT-433; RT-290 mapping rules M-2, M-3,
-- M-10). [GATED] migration: owner approval by RT-290 comment 11717 Q4
-- ("enforced by a unique active reverse index after a data preflight"); the PR
-- still needs owner review before merge. Applying it to the lab, a live
-- database or any deploy is NOT authorized by that comment.
--
-- 0018 made the active (tenant, store, purpose) index unique but left the
-- reverse (tenant, erpnext_warehouse_ref) index non-unique, so two stores could
-- map one Warehouse and the 017 reconciliation would compare each store's
-- on-hand against the whole shared Bin. This migration:
--   1. checks the existing data and FAILS LOUDLY on any Warehouse ref held by
--      more than one active row in a tenant (tenant, ref and every
--      store:purpose are named). It never picks a winner or retires a row;
--   2. replaces idx_erpnext_warehouse_map_ref with the unique partial index
--      UQ_idx_erpnext_warehouse_map_ref_active on the same key and predicate.
-- Retired rows are history and never count. The key ignores `purpose`, so one
-- store cannot hold a `stock` and a `returns` row on the same Warehouse either
-- (M-2: a Warehouse belongs to at most one bucket); the preflight checks that
-- exact key, so it reports every row the index would reject.
--
-- RLS: erpnext_warehouse_map is FORCE ROW LEVEL SECURITY and its read policy
-- honours only app.current_tenant. The deploy migration owner is not a
-- superuser, so a plain GROUP BY would see no rows and pass. The preflight
-- loops over tenants (read under app.is_platform_admin, which
-- tenants_tenant_isolation honours) and sets app.current_tenant per tenant, as
-- 0038 does. The explicit tenant predicate keeps the result identical when the
-- migration runs as a superuser. app.current_tenant is first set to the nil
-- UUID, because the tenants policy casts it without the empty-GUC guard (see
-- the DO block).
--
-- Lock impact: ACCESS EXCLUSIVE on erpnext_warehouse_map for the whole
-- transaction, taken up front. The plain DROP INDEX needs it anyway; taking it
-- first means no mapping can be written between the preflight and the build,
-- and the lock never escalates mid-transaction. Every read and write of the
-- table (posting precondition and freeze, posting feed, reconciliation, the
-- admin list and set/retire) waits until COMMIT. The table holds about one
-- row per store, so that is milliseconds. Not CONCURRENTLY, on purpose: the
-- preflight and the build must be one transaction, and a table this small
-- gains nothing from it. As with any migration, check pg_stat_activity for
-- long-open transactions first: the lock waits behind them.
--
-- If the preflight fails: nothing changed. Retire all but one active mapping
-- per reported Warehouse (POST .../erpnext-warehouse-mappings/{id}/retire),
-- then re-run `migrate up`.
--
-- No data changes. Reversible via 0075_erpnext_warehouse_map_ref_unique.down.sql.

BEGIN;

LOCK TABLE erpnext_warehouse_map IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  t uuid;
  offender text;
  offenders text[] := ARRAY[]::text[];
BEGIN
  -- Transaction-local (is_local = true): both settings end at COMMIT.
  PERFORM set_config('app.is_platform_admin', 'true', true);
  -- tenants_tenant_isolation (0000) casts app.current_tenant with a bare
  -- ::uuid. Once an earlier transaction in this session set it locally (an
  -- earlier migration in the same `migrate up`), it reads '' and the cast
  -- throws 22P02. The nil UUID matches no tenant; the platform-admin branch
  -- admits every tenant.
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  FOR t IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    FOR offender IN
      SELECT format('tenant=%s ref=%L maps=%s',
                    tenant_id, erpnext_warehouse_ref,
                    string_agg(store_id::text || ':' || purpose, ',' ORDER BY store_id, purpose))
        FROM erpnext_warehouse_map
       WHERE tenant_id = t AND retired_at IS NULL
       GROUP BY tenant_id, erpnext_warehouse_ref
      HAVING count(*) > 1
       ORDER BY erpnext_warehouse_ref
    LOOP
      offenders := offenders || offender;
    END LOOP;
  END LOOP;

  IF cardinality(offenders) > 0 THEN
    RAISE EXCEPTION 'RT-433 preflight: % ERPNext Warehouse ref(s) are held by more than one active erpnext_warehouse_map row: %',
      cardinality(offenders), array_to_string(offenders, '; ')
      USING ERRCODE = 'unique_violation',
            HINT = 'Retire all but one active mapping per Warehouse, then re-run migrate up. Nothing was changed.';
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_erpnext_warehouse_map_ref;

CREATE UNIQUE INDEX "UQ_idx_erpnext_warehouse_map_ref_active"
  ON erpnext_warehouse_map (tenant_id, erpnext_warehouse_ref)
  WHERE retired_at IS NULL;

COMMIT;
