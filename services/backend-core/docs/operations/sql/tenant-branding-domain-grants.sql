-- Domain-role grants for the tenant logo branding (RT-473 S2, migration 0076).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0076 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/tenant-branding-domain-grants.sql
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
-- with the boot check off, every Console logo operation and every POS branding
-- read fails with permission denied. All three tables are FORCE ROW LEVEL
-- SECURITY by tenant, so the grants give access only inside
-- runWithTenantContext.
--
-- tenant_branding_revisions: SELECT, INSERT, UPDATE. The first logo write
-- creates the tenant's row; every later write moves it up by one.
-- tenant_logos: SELECT, INSERT, UPDATE, DELETE. Save upserts the one row per
-- tenant; remove deletes it.
-- tenant_logo_renditions: SELECT, INSERT, UPDATE. Save upserts the nine
-- renditions; remove relies on ON DELETE CASCADE from tenant_logos.
-- Never grant TRUNCATE on any of them (TRUNCATE is not subject to row
-- security), and never DELETE on tenant_branding_revisions (a revision must
-- never repeat) or tenant_logo_renditions.
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's logo.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON tenant_branding_revisions TO :"domain_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_logos TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON tenant_logo_renditions TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('tenant_branding_revisions', 'SELECT'),
               ('tenant_branding_revisions', 'INSERT'),
               ('tenant_branding_revisions', 'UPDATE'),
               ('tenant_logos', 'SELECT'),
               ('tenant_logos', 'INSERT'),
               ('tenant_logos', 'UPDATE'),
               ('tenant_logos', 'DELETE'),
               ('tenant_logo_renditions', 'SELECT'),
               ('tenant_logo_renditions', 'INSERT'),
               ('tenant_logo_renditions', 'UPDATE')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('tenant_branding_revisions', 'SELECT'),
               ('tenant_branding_revisions', 'INSERT'),
               ('tenant_branding_revisions', 'UPDATE'),
               ('tenant_logos', 'SELECT'),
               ('tenant_logos', 'INSERT'),
               ('tenant_logos', 'UPDATE'),
               ('tenant_logos', 'DELETE'),
               ('tenant_logo_renditions', 'SELECT'),
               ('tenant_logo_renditions', 'INSERT'),
               ('tenant_logo_renditions', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required tenant branding grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'tenant branding domain grants incomplete'; END $$;
\endif
