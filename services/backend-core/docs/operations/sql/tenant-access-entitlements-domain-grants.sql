-- Domain-role grants for the tenant access state (RT-1353, migration 0104).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0104 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on this table). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/tenant-access-entitlements-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212);
-- with the boot check off, the POS pairing, the ERP posting gates and the
-- entitlement routes fail with permission denied. The table is FORCE ROW LEVEL
-- SECURITY by tenant, so the grants give access only inside
-- runWithTenantContext, and only a platform-admin context may write.
--
-- tenant_access_entitlements: SELECT, INSERT, UPDATE. Never DELETE (no row is
-- ever removed) and never TRUNCATE (TRUNCATE is not subject to row security).
--
-- The auth lookup role must hold NO privilege on this table
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's access state.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON tenant_access_entitlements TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('tenant_access_entitlements', 'SELECT'),
               ('tenant_access_entitlements', 'INSERT'),
               ('tenant_access_entitlements', 'UPDATE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('tenant_access_entitlements', 'SELECT'),
               ('tenant_access_entitlements', 'INSERT'),
               ('tenant_access_entitlements', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required tenant access entitlement grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'tenant access entitlement domain grants incomplete'; END $$;
\endif
