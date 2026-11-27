-- 0136_erp_credential_rotation.down.sql — reverses 0136_erp_credential_rotation.sql (RT-1362 S2).
--
-- Run 0139, 0138 and 0137 down first (the runner does, in reverse order). 0139 down rebuilds the
-- one-unrevoked-credential index and fails while any registration still has a pending credential, so
-- no pending credential reaches this file unrevoked.
--
-- REFUSES (SQLSTATE P0001) while any `credential.rotate` request exists, so rotation history is never
-- discarded silently. That one count covers the other new state too: a pending credential must name a
-- `credential.rotate` request (composite FK), and the S2 runtime records an adopted registration's
-- provisioner host only in the rotate-now transaction that creates or returns such a request. Roll the
-- S2 runtime back first, then remove those rows by hand with the owner's approval.
-- The count runs as the platform admin (`app.is_platform_admin`, transaction-local; 0109 gives that flag
-- a SELECT policy on erp_provisioning_request) because the table is FORCE RLS and the migration owner is
-- NOSUPERUSER: without it the owner would read 0 rows and the refusal would never fire.
--
-- Then it drops the request index, the pending FK and its unique target, the CHECKs and the six columns.

BEGIN;

SET LOCAL lock_timeout = '2s';

SELECT set_config('app.is_platform_admin', 'true', true);

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM erp_provisioning_request WHERE kind = 'credential.rotate';
  IF n > 0 THEN
    RAISE EXCEPTION '0136 down refused: % credential.rotate request(s) exist', n;
  END IF;
END
$$;

SELECT set_config('app.is_platform_admin', 'false', true);

DROP INDEX IF EXISTS uq_erp_provisioning_request_open_credential_rotate;

-- The FK first: it depends on the request's (id, tenant_id, connector_registration_id) unique key.
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_pending_rotation_request_fk;
ALTER TABLE erp_provisioning_request DROP CONSTRAINT IF EXISTS uq_erp_provisioning_request_id_tenant_registration;

ALTER TABLE erp_provisioning_request DROP CONSTRAINT IF EXISTS erp_provisioning_request_rotation_shape;
ALTER TABLE erp_provisioning_request DROP COLUMN IF EXISTS rotation_trigger;
ALTER TABLE erp_provisioning_request DROP COLUMN IF EXISTS routed_host_label;

ALTER TABLE connector_registration DROP CONSTRAINT IF EXISTS connector_registration_provisioner_host_binding_valid;
ALTER TABLE connector_registration DROP COLUMN IF EXISTS provisioner_host_binding_revision;
ALTER TABLE connector_registration DROP COLUMN IF EXISTS provisioner_host_binding;
ALTER TABLE connector_registration DROP COLUMN IF EXISTS provisioner_host_label;

ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_pending_rotation_shape;
ALTER TABLE auth_tokens DROP COLUMN IF EXISTS pending_rotation_request_id;

COMMIT;
