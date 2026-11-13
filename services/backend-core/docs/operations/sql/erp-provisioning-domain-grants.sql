-- Domain-role grants for ERP provisioning storage (RT-1357, migration 0109).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0109 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/erp-provisioning-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212).
-- The API and the worker share this DATABASE_URL role. All three tables are
-- FORCE ROW LEVEL SECURITY: the grants give access only inside a session that
-- sets the matching setting (app.current_tenant for a tenant's own read,
-- app.is_platform_admin, or app.is_provisioner; the last one only on the
-- provisioner-bearer path).
--
-- erp_provisioning_request:  SELECT, INSERT, UPDATE.
-- erp_provisioning_step_log: SELECT, INSERT (append-only: never UPDATE).
-- erp_provisioner_credential: SELECT, INSERT, UPDATE (revocation is an UPDATE).
-- Never DELETE and never TRUNCATE (TRUNCATE is not subject to row security).
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's provisioning state.
--
-- ROLLBACK (only after the 0109 down migration succeeded, or to withdraw the
-- access while the tables stay): as the migration owner,
--   REVOKE ALL ON erp_provisioning_request, erp_provisioning_step_log,
--                 erp_provisioner_credential FROM <domain_role>;
-- Roll back the PB-C API first: with the grants gone the API refuses to boot
-- (DOMAIN_REQUIRED_GRANTS) once this fragment is part of its release.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON erp_provisioning_request TO :"domain_role";
GRANT SELECT, INSERT ON erp_provisioning_step_log TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON erp_provisioner_credential TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('erp_provisioning_request', 'SELECT'),
               ('erp_provisioning_request', 'INSERT'),
               ('erp_provisioning_request', 'UPDATE'),
               ('erp_provisioning_step_log', 'SELECT'),
               ('erp_provisioning_step_log', 'INSERT'),
               ('erp_provisioner_credential', 'SELECT'),
               ('erp_provisioner_credential', 'INSERT'),
               ('erp_provisioner_credential', 'UPDATE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('erp_provisioning_request', 'SELECT'),
               ('erp_provisioning_request', 'INSERT'),
               ('erp_provisioning_request', 'UPDATE'),
               ('erp_provisioning_step_log', 'SELECT'),
               ('erp_provisioning_step_log', 'INSERT'),
               ('erp_provisioner_credential', 'SELECT'),
               ('erp_provisioner_credential', 'INSERT'),
               ('erp_provisioner_credential', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required ERP provisioning grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'ERP provisioning domain grants incomplete'; END $$;
\endif
