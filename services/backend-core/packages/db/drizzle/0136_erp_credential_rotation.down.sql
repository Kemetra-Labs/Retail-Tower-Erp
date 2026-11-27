-- 0136_erp_credential_rotation.down.sql — reverses 0136_erp_credential_rotation.sql (RT-1362 S2).
--
-- Run 0141 to 0137 down first (the runner does, in reverse order). auth_tokens is not touched here: its
-- pending marker is 0139's, reversed in 0139's own down.
--
-- ONE transaction for the two small tables. It first takes ACCESS EXCLUSIVE on both (lock_timeout 2s), so
-- no writer can add a rotation request or a host binding between the check and the drop, then REFUSES
-- (SQLSTATE P0001) while any `credential.rotate` request or any provisioner host binding exists, so
-- rotation history and a recorded host are never discarded silently. Roll the S2 runtime back first, then
-- remove those rows or values by hand with the owner's approval.
--
-- The checks must see every tenant although both tables are FORCE RLS and the migration owner is
-- NOSUPERUSER:
--   - erp_provisioning_request has a platform-admin SELECT policy (0109): the platform-admin flag
--     (transaction-local) admits every row;
--   - connector_registration has tenant policies only (0021), so the check pins each tenant in turn,
--     the 0075 pattern: the platform-admin flag and the nil UUID let `tenants` (0000 policy, bare ::uuid
--     cast, which an earlier '' would break with 22P02) list every tenant, then `app.current_tenant` is
--     set per tenant with an explicit `tenant_id = t` predicate.
-- Both settings are transaction-local and end at COMMIT.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE erp_provisioning_request, connector_registration IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  n bigint;
  bound bigint := 0;
  t uuid;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  SELECT count(*) INTO n FROM erp_provisioning_request WHERE kind = 'credential.rotate';
  IF n > 0 THEN
    RAISE EXCEPTION '0136 down refused: % credential.rotate request(s) exist', n;
  END IF;
  FOR t IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    SELECT bound + count(*) INTO bound FROM connector_registration
     WHERE tenant_id = t AND provisioner_host_label IS NOT NULL;
  END LOOP;
  IF bound > 0 THEN
    RAISE EXCEPTION '0136 down refused: % connector registration(s) carry a provisioner host binding', bound;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'false', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
END
$$;

ALTER TABLE erp_provisioning_request DROP CONSTRAINT IF EXISTS erp_provisioning_request_rotation_shape;
ALTER TABLE erp_provisioning_request DROP COLUMN IF EXISTS rotation_trigger;
ALTER TABLE erp_provisioning_request DROP COLUMN IF EXISTS routed_host_label;

ALTER TABLE connector_registration DROP CONSTRAINT IF EXISTS connector_registration_provisioner_host_binding_valid;
ALTER TABLE connector_registration DROP COLUMN IF EXISTS provisioner_host_binding_revision;
ALTER TABLE connector_registration DROP COLUMN IF EXISTS provisioner_host_binding;
ALTER TABLE connector_registration DROP COLUMN IF EXISTS provisioner_host_label;

COMMIT;
