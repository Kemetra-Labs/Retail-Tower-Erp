-- 0120_membership_bootstrap_policies.down.sql (RT-1457): drop exactly the five policies 0120 added.
-- Roll the api back first: the new code runs the request bootstrap reads on
-- `app.system_privilege = 'membership_bootstrap'`, which no policy honours after this.

BEGIN;

SET LOCAL lock_timeout = '2s';

DROP POLICY IF EXISTS memberships_membership_bootstrap_select ON memberships;
DROP POLICY IF EXISTS roles_membership_bootstrap_select ON roles;
DROP POLICY IF EXISTS tenants_membership_bootstrap_select ON tenants;
DROP POLICY IF EXISTS stores_membership_bootstrap_select ON stores;
DROP POLICY IF EXISTS store_access_membership_bootstrap_select ON store_access;

COMMIT;
