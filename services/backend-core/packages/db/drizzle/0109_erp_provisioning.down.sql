-- 0109_erp_provisioning.down.sql - reverses 0109_erp_provisioning.sql (RT-1357).
--
-- REFUSES (SQLSTATE P0001) while any provisioning data exists, so provisioning
-- history, a live provisioner credential or a managed registration is never
-- discarded silently: any erp_provisioning_request, erp_provisioning_step_log
-- or erp_provisioner_credential row, any `connector_provisioner` token, any
-- connector_registration with managed_by set. Roll back the PB-C service first,
-- revoke and delete those rows by hand with the owner's approval, then re-run.
--
-- Then it drops, in dependency order: the three tables (their policies,
-- triggers and indexes go with them) and the two trigger functions; the
-- managed_by column; the provisioner shape CHECK; restores auth_tokens_scope_valid
-- to the six-scope set of 0021; drops the users CHECK; and deletes the seeded
-- system actor (nothing else references it once the refusal above passed; a
-- remaining reference raises a foreign-key error and the whole down rolls back).
-- Deploy rollback of the runtime grants: see
-- docs/operations/sql/erp-provisioning-domain-grants.sql (revoke section).

BEGIN;

SET LOCAL lock_timeout = '2s';

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM erp_provisioning_request;
  IF n > 0 THEN
    RAISE EXCEPTION '0109 down refused: % erp_provisioning_request row(s) exist', n;
  END IF;
  SELECT count(*) INTO n FROM erp_provisioning_step_log;
  IF n > 0 THEN
    RAISE EXCEPTION '0109 down refused: % erp_provisioning_step_log row(s) exist', n;
  END IF;
  SELECT count(*) INTO n FROM erp_provisioner_credential;
  IF n > 0 THEN
    RAISE EXCEPTION '0109 down refused: % erp_provisioner_credential row(s) exist', n;
  END IF;
  SELECT count(*) INTO n FROM auth_tokens WHERE scope = 'connector_provisioner';
  IF n > 0 THEN
    RAISE EXCEPTION '0109 down refused: % connector_provisioner token(s) exist', n;
  END IF;
  SELECT count(*) INTO n FROM connector_registration WHERE managed_by IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '0109 down refused: % managed connector registration(s) exist', n;
  END IF;
END
$$;

DROP TABLE IF EXISTS erp_provisioner_credential;
DROP TABLE IF EXISTS erp_provisioning_step_log;
DROP TABLE IF EXISTS erp_provisioning_request;
DROP FUNCTION IF EXISTS erp_provisioning_step_log_append_only();
DROP FUNCTION IF EXISTS erp_provisioning_request_guard();

ALTER TABLE connector_registration DROP CONSTRAINT IF EXISTS connector_registration_managed_by_valid;
ALTER TABLE connector_registration DROP COLUMN IF EXISTS managed_by;

ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_provisioner_shape;
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_scope_valid;
ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_scope_valid
    CHECK (scope IN (
      'dashboard_api', 'pos', 'pos_operator',
      'connector', 'password_reset', 'email_verify'
    ))
    NOT VALID;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_system_actor_no_login;
DELETE FROM users WHERE id = '00000000-0000-7000-8000-000000001357';

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE auth_tokens VALIDATE CONSTRAINT auth_tokens_scope_valid;
COMMIT;
