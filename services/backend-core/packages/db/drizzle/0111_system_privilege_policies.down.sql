-- 0111_system_privilege_policies.down.sql (RT-1389): drop exactly the policies 0111 added.
-- Roll the api and worker back first: the new code runs signup, the provisioner lookup and
-- the sweep on `app.system_privilege`, which no policy honours after this.

BEGIN;

SET LOCAL lock_timeout = '2s';

DROP POLICY IF EXISTS pending_signups_signup_select ON pending_signups;
DROP POLICY IF EXISTS pending_signups_signup_insert ON pending_signups;
DROP POLICY IF EXISTS pending_signups_signup_update ON pending_signups;
DROP POLICY IF EXISTS user_consents_signup_select ON user_consents;
DROP POLICY IF EXISTS user_consents_signup_insert ON user_consents;
DROP POLICY IF EXISTS tenant_access_entitlements_signup_insert ON tenant_access_entitlements;
DROP POLICY IF EXISTS erp_provisioning_request_sweep_select ON erp_provisioning_request;
DROP POLICY IF EXISTS erp_provisioning_request_sweep_update ON erp_provisioning_request;
DROP POLICY IF EXISTS erp_provisioner_credential_lookup_select ON erp_provisioner_credential;

COMMIT;
