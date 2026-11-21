-- Domain-role grants for the sync-failure email alert (RT-1034, migration 0130).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0130 and BEFORE the
-- worker image that needs it is rolled, as the migration owner. This file holds
-- NO credential. Give psql the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/sync-failure-alerts-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- Both alert tables: SELECT, INSERT, UPDATE. Never DELETE and never TRUNCATE
-- (TRUNCATE is not subject to row security). The alert needs NO write grant on
-- posting, reconciliation or sale tables and none is given here.
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS.

\set ON_ERROR_STOP on

\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON sync_failure_alert_windows TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON sync_failure_alert_deliveries TO :"domain_role";

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('sync_failure_alert_windows', 'SELECT'),
               ('sync_failure_alert_windows', 'INSERT'),
               ('sync_failure_alert_windows', 'UPDATE'),
               ('sync_failure_alert_deliveries', 'SELECT'),
               ('sync_failure_alert_deliveries', 'INSERT'),
               ('sync_failure_alert_deliveries', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required sync-failure alert grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant.'
  DO $$ BEGIN RAISE EXCEPTION 'sync-failure alert domain grants incomplete'; END $$;
\endif
