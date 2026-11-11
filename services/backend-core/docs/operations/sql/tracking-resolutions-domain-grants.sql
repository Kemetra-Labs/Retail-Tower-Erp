-- Domain-role grants for the Tracking Resolution of tracked selling (RT-451 S5,
-- migration 0094). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0094 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/tracking-resolutions-domain-grants.sql
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
-- with the boot check off, the bind fails with permission denied and the
-- worker cannot process a sale. Both tables are FORCE ROW LEVEL SECURITY by
-- tenant, so the grants give access only inside runWithTenantContext.
--
-- tracking_resolutions, tracking_resolution_lines: SELECT, INSERT. The
-- owner-only bind appends a resolution and its line bindings;
-- `listTrackingResolutionQueue` and the sale effect writer (API and worker)
-- read them. Never grant UPDATE, DELETE or TRUNCATE: the tables have no UPDATE
-- or DELETE policy (append-only), and TRUNCATE is not subject to row security.
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

GRANT SELECT, INSERT ON tracking_resolutions TO :"domain_role";
GRANT SELECT, INSERT ON tracking_resolution_lines TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('tracking_resolutions', 'SELECT'),
               ('tracking_resolutions', 'INSERT'),
               ('tracking_resolution_lines', 'SELECT'),
               ('tracking_resolution_lines', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('tracking_resolutions', 'SELECT'),
               ('tracking_resolutions', 'INSERT'),
               ('tracking_resolution_lines', 'SELECT'),
               ('tracking_resolution_lines', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required tracking resolution grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'tracking resolution domain grants incomplete'; END $$;
\endif
