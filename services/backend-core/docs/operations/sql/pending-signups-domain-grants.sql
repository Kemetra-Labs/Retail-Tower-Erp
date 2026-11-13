-- Domain-role grants for the pre-tenant self-signup tables (RT-1350 slice 2,
-- migration 0107). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0107 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/pending-signups-domain-grants.sql
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
-- Both tables are FORCE ROW LEVEL SECURITY with NO tenant policy and one
-- platform-admin policy per command, so the grants give access only inside a
-- platform-admin context; a tenant session sees nothing.
--
-- pending_signups: SELECT, INSERT, UPDATE. No DELETE yet (the purge job of a
-- later slice adds it) and never TRUNCATE (TRUNCATE is not subject to row
-- security).
-- user_consents: SELECT, INSERT (append-only). Never UPDATE, DELETE or TRUNCATE.
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every pending signup's email address.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON pending_signups TO :"domain_role";
GRANT SELECT, INSERT ON user_consents TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('pending_signups', 'SELECT'),
               ('pending_signups', 'INSERT'),
               ('pending_signups', 'UPDATE'),
               ('user_consents', 'SELECT'),
               ('user_consents', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('pending_signups', 'SELECT'),
               ('pending_signups', 'INSERT'),
               ('pending_signups', 'UPDATE'),
               ('user_consents', 'SELECT'),
               ('user_consents', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required self-signup grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'self-signup domain grants incomplete'; END $$;
\endif
