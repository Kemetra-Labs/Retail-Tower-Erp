-- Domain-role grants for the POS pilot release registry and the pilot tenant
-- allowlist (RT-1292, migration 0088). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0088 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/pos-pilot-releases-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212); with
-- the boot check off, the Console pilot release read and the platform allowlist
-- routes fail with permission denied. Both tables are FORCE ROW LEVEL SECURITY:
-- the registry is readable by every context and writable only in the
-- platform-admin context; the allowlist is readable for the tenant's own row or
-- by a platform admin, and writable only by a platform admin, so the grants give
-- access only inside runWithTenantContext.
--
-- pos_pilot_release_registry: SELECT, INSERT, UPDATE. The resolver reads it; the
-- registry writes create a row and set approval, withdrawal and activation.
-- Never grant DELETE or TRUNCATE: it has no DELETE policy, and TRUNCATE is not
-- subject to row security.
-- pos_pilot_tenant_allowlist: SELECT, INSERT, DELETE. The resolver reads the
-- tenant's own row; the platform admin adds and removes tenants. It has no
-- UPDATE policy. Never grant TRUNCATE.
--
-- The auth lookup role must hold NO privilege on either table
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's rows.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON pos_pilot_release_registry TO :"domain_role";
GRANT SELECT, INSERT, DELETE ON pos_pilot_tenant_allowlist TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('pos_pilot_release_registry', 'SELECT'),
               ('pos_pilot_release_registry', 'INSERT'),
               ('pos_pilot_release_registry', 'UPDATE'),
               ('pos_pilot_tenant_allowlist', 'SELECT'),
               ('pos_pilot_tenant_allowlist', 'INSERT'),
               ('pos_pilot_tenant_allowlist', 'DELETE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('pos_pilot_release_registry', 'SELECT'),
               ('pos_pilot_release_registry', 'INSERT'),
               ('pos_pilot_release_registry', 'UPDATE'),
               ('pos_pilot_tenant_allowlist', 'SELECT'),
               ('pos_pilot_tenant_allowlist', 'INSERT'),
               ('pos_pilot_tenant_allowlist', 'DELETE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required POS pilot release grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'POS pilot release domain grants incomplete'; END $$;
\endif
