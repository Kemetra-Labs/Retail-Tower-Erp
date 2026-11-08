-- Domain-role grants for the POS Tracked Line Validation record (RT-451 S2,
-- migration 0087). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0087 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on this table). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/tracked-line-validations-domain-grants.sql
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
-- with the boot check off, every TLV (`posValidateTrackedLine`) fails with
-- permission denied. The table is FORCE ROW LEVEL SECURITY by tenant, so the
-- grants give access only inside runWithTenantContext.
--
-- tracked_line_validations: SELECT, INSERT. Every TLV appends one record; a
-- sale line's citation reads it (RT-451 S3). Never grant UPDATE, DELETE or
-- TRUNCATE: the table has no UPDATE or DELETE policy (append-only), and
-- TRUNCATE is not subject to row security.
--
-- The auth lookup role must hold NO privilege on the table
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

GRANT SELECT, INSERT ON tracked_line_validations TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('tracked_line_validations', 'SELECT'),
               ('tracked_line_validations', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('tracked_line_validations', 'SELECT'),
               ('tracked_line_validations', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required tracked line validation grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'tracked line validation domain grants incomplete'; END $$;
\endif
