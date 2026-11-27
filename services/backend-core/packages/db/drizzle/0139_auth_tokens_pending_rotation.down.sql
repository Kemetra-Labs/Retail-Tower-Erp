-- 0139_auth_tokens_pending_rotation.down.sql — reverses 0139 (RT-1362 S2). Run 0141 and 0140 down first.
--
-- auth_tokens alone, in one short transaction: ACCESS EXCLUSIVE is taken first (lock_timeout 2s), so no writer can
-- add a pending credential between the check and the drop; then it REFUSES (SQLSTATE P0001) while any credential
-- carries a pending marker, so an unpromoted rotation is never discarded silently (revoke or promote it first). The
-- check must see every tenant under FORCE RLS as the NOSUPERUSER owner: the 0000 auth_tokens policy admits every row
-- to the platform-admin flag, and its bare ::uuid cast of `app.current_tenant` is made valid by pinning the nil UUID
-- (both transaction-local). Then the FK (before 0138's index it depends on is dropped), the CHECK and the two
-- columns are dropped.

BEGIN;

SET LOCAL lock_timeout = '2s';

LOCK TABLE auth_tokens IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  PERFORM set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true);
  SELECT count(*) INTO n FROM auth_tokens WHERE pending_rotation_request_id IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '0139 down refused: % pending connector credential(s) exist', n;
  END IF;
  PERFORM set_config('app.is_platform_admin', 'false', true);
END
$$;

ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_pending_rotation_request_fk;
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_pending_rotation_shape;
ALTER TABLE auth_tokens DROP COLUMN IF EXISTS pending_rotation_kind;
ALTER TABLE auth_tokens DROP COLUMN IF EXISTS pending_rotation_request_id;

COMMIT;
