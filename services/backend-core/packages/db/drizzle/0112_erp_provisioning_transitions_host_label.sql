-- 0112_erp_provisioning_transitions_host_label.sql (RT-1389 Phase 2, owner go-ahead 2026-11-14)
-- `[GATED: migration]`. DDL only; the backfill is 0113 (its own transaction).
--
-- 1. Status transitions enforced in SQL. Until now only the api repository checked the
--    transition table; the worker sweep wrote `status` with raw SQL and the 0109 guard
--    trigger did not consult a from->to table. `erp_provisioning_transition_allowed(from, to)`
--    encodes the SAME table as `ERP_PROVISIONING_ALLOWED_TRANSITIONS`
--    (packages/db/src/helpers/erp-provisioning-transitions.ts); the 0112 spec checks that both
--    agree on every (from, to) pair. The guard trigger now refuses any other status change
--    (SQLSTATE 23514). An update that keeps the status (lease take/renew/clear, counters) is
--    always allowed.
--
-- 2. `provisioned_host_label`: the host that provisioned a `succeeded` request, the OD-10
--    per-host site count input (20 sites per host). It replaces the SYNTHETIC ended lease a
--    succeeded row kept only to remember its host (RT-1358 known compromise; RT-1361 comment
--    16947 item 2, landed here). NULL on every other row; NULL on a succeeded row whose host is
--    not known (counted by the sweep as `hostUnknown`, never under a made-up host). Once set it
--    never changes (guard trigger).
--
-- The new column starts NULL on every row, so its CHECK is valid at once (no table scan of
-- consequence: the table holds one row per provisioning request).
--
-- Rollback: 0112_erp_provisioning_transitions_host_label.down.sql restores the 0109 guard body,
-- drops the transition function and the column. Run 0113's down first (it moves the host back
-- into the lease columns).

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE erp_provisioning_request
  ADD COLUMN IF NOT EXISTS provisioned_host_label TEXT;

ALTER TABLE erp_provisioning_request
  DROP CONSTRAINT IF EXISTS erp_provisioning_request_provisioned_host_label_valid;
ALTER TABLE erp_provisioning_request
  ADD CONSTRAINT erp_provisioning_request_provisioned_host_label_valid
  CHECK (provisioned_host_label IS NULL
         OR (status = 'succeeded' AND length(provisioned_host_label) BETWEEN 1 AND 64));

-- The transition table. Keep in lockstep with ERP_PROVISIONING_ALLOWED_TRANSITIONS.
CREATE OR REPLACE FUNCTION erp_provisioning_transition_allowed(from_status TEXT, to_status TEXT) RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT from_status = to_status OR (from_status, to_status) IN (
    ('requested', 'claimed'), ('requested', 'cancelled'),
    ('claimed', 'site_created'), ('claimed', 'erp_configured'), ('claimed', 'connector_installed'),
    ('claimed', 'credential_bound'), ('claimed', 'verifying'), ('claimed', 'failed_retryable'),
    ('claimed', 'failed_permanent'), ('claimed', 'cancelled'),
    ('site_created', 'erp_configured'), ('site_created', 'connector_installed'),
    ('site_created', 'credential_bound'), ('site_created', 'verifying'),
    ('site_created', 'failed_retryable'), ('site_created', 'failed_permanent'), ('site_created', 'cancelled'),
    ('erp_configured', 'connector_installed'), ('erp_configured', 'credential_bound'),
    ('erp_configured', 'verifying'), ('erp_configured', 'failed_retryable'),
    ('erp_configured', 'failed_permanent'), ('erp_configured', 'cancelled'),
    ('connector_installed', 'credential_bound'), ('connector_installed', 'verifying'),
    ('connector_installed', 'failed_retryable'), ('connector_installed', 'failed_permanent'),
    ('connector_installed', 'cancelled'),
    ('credential_bound', 'verifying'), ('credential_bound', 'failed_retryable'),
    ('credential_bound', 'failed_permanent'), ('credential_bound', 'cancelled'),
    ('verifying', 'succeeded'), ('verifying', 'failed_retryable'),
    ('verifying', 'failed_permanent'), ('verifying', 'cancelled'),
    ('failed_retryable', 'claimed'), ('failed_retryable', 'failed_permanent'), ('failed_retryable', 'cancelled')
  )
$$;

-- The 0109 guard, plus the transition check and the frozen host label.
CREATE OR REPLACE FUNCTION erp_provisioning_request_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kind <> OLD.kind
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'erp_provisioning_request: id, tenant_id, kind and created_at are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'erp_provisioning_request: generation never decreases'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempt_floor < OLD.attempt_floor THEN
    RAISE EXCEPTION 'erp_provisioning_request: attempt_floor never decreases'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT erp_provisioning_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'erp_provisioning_request: transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provisioned_host_label IS NOT NULL
     AND NEW.provisioned_host_label IS DISTINCT FROM OLD.provisioned_host_label THEN
    RAISE EXCEPTION 'erp_provisioning_request: provisioned_host_label never changes once set'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMIT;
