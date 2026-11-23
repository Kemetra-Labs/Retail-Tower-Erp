-- Domain-role grants for the pricing authority row (RT-1485, migration 0132, spec 044 PR-16a-1).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0132 and BEFORE the
-- API image that needs it is rolled, as the migration owner. This file holds
-- NO credential. Give psql the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/pricing-authority-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- tenant_pricing_authority: SELECT only. Never INSERT, UPDATE, DELETE or
-- TRUNCATE: a runtime role that could change the row could unfreeze its own
-- legacy prices (spec 044 §6.2). pricing_import_runs and pricing_cutover_runs:
-- nothing yet. The domain role must never be a member of
-- pricing_projection_writer, and never holds EXECUTE on pricing_reverse_project.
--
-- The auth lookup role must hold NO privilege on the three tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS.

\set ON_ERROR_STOP on

\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT ON tenant_pricing_authority TO :"domain_role";

SELECT has_table_privilege(:'domain_role', 'tenant_pricing_authority', 'SELECT') AS domain_ok \gset

\if :domain_ok
  \echo 'OK: domain role holds the required pricing authority grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant.'
  DO $$ BEGIN RAISE EXCEPTION 'pricing authority domain grants incomplete'; END $$;
\endif
