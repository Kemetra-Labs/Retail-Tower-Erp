-- Domain-role grants for the W9 redistribution proposals (RT-1600, migration 0135).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0135 and BEFORE the
-- API image that needs it is rolled, as the migration owner. This file holds
-- NO credential. Give psql the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/redistribution-proposals-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- Both proposal tables: SELECT, INSERT, UPDATE. Never DELETE and never TRUNCATE
-- (TRUNCATE is not subject to row security). An accept writes W3 draft
-- Transfers through the shipment Transfer grants; nothing more is given here.
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS.

\set ON_ERROR_STOP on

\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON redistribution_proposals TO :"domain_role";
GRANT SELECT, INSERT, UPDATE ON redistribution_proposal_lines TO :"domain_role";

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('redistribution_proposals', 'SELECT'),
               ('redistribution_proposals', 'INSERT'),
               ('redistribution_proposals', 'UPDATE'),
               ('redistribution_proposal_lines', 'SELECT'),
               ('redistribution_proposal_lines', 'INSERT'),
               ('redistribution_proposal_lines', 'UPDATE')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required redistribution proposal grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant.'
  DO $$ BEGIN RAISE EXCEPTION 'redistribution proposal domain grants incomplete'; END $$;
\endif
