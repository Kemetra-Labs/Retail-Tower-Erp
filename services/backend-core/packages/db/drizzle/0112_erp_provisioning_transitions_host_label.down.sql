-- 0112_erp_provisioning_transitions_host_label.down.sql (RT-1389): restore the 0109 guard body,
-- drop the transition function and the host-label column. Run 0113's down first, which moves
-- each recorded host back into the (synthetic, ended) lease columns the old code reads.

BEGIN;

SET LOCAL lock_timeout = '2s';

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
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP FUNCTION IF EXISTS erp_provisioning_transition_allowed(TEXT, TEXT);

ALTER TABLE erp_provisioning_request
  DROP CONSTRAINT IF EXISTS erp_provisioning_request_provisioned_host_label_valid;
ALTER TABLE erp_provisioning_request
  DROP COLUMN IF EXISTS provisioned_host_label;

COMMIT;
