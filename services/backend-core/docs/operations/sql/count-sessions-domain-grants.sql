-- Domain-role grants for the Count Session tables (RT-1420, migration 0114).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0114 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> --        -f docs/operations/sql/count-sessions-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant.
--
-- count_sessions, count_session_lines: SELECT, INSERT, UPDATE (state changes).
-- count_session_expected, count_observations, count_late_event_findings:
-- SELECT, INSERT (append-only). Never grant DELETE or TRUNCATE: TRUNCATE is
-- not subject to row security.
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's rows.

\set ON_ERROR_STOP on

\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON count_sessions, count_session_lines TO :"domain_role";
GRANT SELECT, INSERT ON count_session_expected, count_observations, count_late_event_findings TO :"domain_role";
-- RT-1424 (0118): append-only late-event compensations.
GRANT SELECT, INSERT ON count_late_compensations TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('count_sessions', 'SELECT'),
               ('count_sessions', 'INSERT'),
               ('count_sessions', 'UPDATE'),
               ('count_session_lines', 'SELECT'),
               ('count_session_lines', 'INSERT'),
               ('count_session_lines', 'UPDATE'),
               ('count_session_expected', 'SELECT'),
               ('count_session_expected', 'INSERT'),
               ('count_observations', 'SELECT'),
               ('count_observations', 'INSERT'),
               ('count_late_event_findings', 'SELECT'),
               ('count_late_event_findings', 'INSERT'),
               ('count_late_compensations', 'SELECT'),
               ('count_late_compensations', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('count_sessions', 'SELECT'),
               ('count_sessions', 'INSERT'),
               ('count_sessions', 'UPDATE'),
               ('count_session_lines', 'SELECT'),
               ('count_session_lines', 'INSERT'),
               ('count_session_lines', 'UPDATE'),
               ('count_session_expected', 'SELECT'),
               ('count_session_expected', 'INSERT'),
               ('count_observations', 'SELECT'),
               ('count_observations', 'INSERT'),
               ('count_late_event_findings', 'SELECT'),
               ('count_late_event_findings', 'INSERT'),
               ('count_late_compensations', 'SELECT'),
               ('count_late_compensations', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required Count Session grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'count session domain grants incomplete'; END $$;
\endif
