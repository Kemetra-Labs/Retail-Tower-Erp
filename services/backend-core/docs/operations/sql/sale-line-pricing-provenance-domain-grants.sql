-- Domain-role grants for sale_line_pricing_provenance (RT-1151, migration 0122).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0122 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on this table). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/sale-line-pricing-provenance-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, so
-- deployment automation cannot accept a failed step.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212). The
-- table is FORCE ROW LEVEL SECURITY by tenant, so the grants give access only
-- inside runWithTenantContext.
--
-- SELECT and INSERT only: the provenance of a sale line is a frozen sale fact,
-- append-only for every role (a trigger refuses UPDATE, DELETE and TRUNCATE).
-- Never grant UPDATE, DELETE or TRUNCATE.
--
-- The auth lookup role must hold NO privilege on this table
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's sale facts.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

BEGIN;

REVOKE UPDATE ON sale_line_pricing_provenance FROM :"domain_role";
GRANT SELECT, INSERT ON sale_line_pricing_provenance TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('sale_line_pricing_provenance', 'SELECT'),
               ('sale_line_pricing_provenance', 'INSERT')) AS t(tbl, priv);

-- No UPDATE: the frozen columns must read `f`.
SELECT c.tbl, c.col, has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE') AS granted
  FROM (VALUES ('sale_line_pricing_provenance', 'origin'),
               ('sale_line_pricing_provenance', 'price_event_id'),
               ('sale_line_pricing_provenance', 'pricing_revision'),
               ('sale_line_pricing_provenance', 'tenant_id')) AS c(tbl, col);

SELECT (SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv))
          FROM (VALUES ('sale_line_pricing_provenance', 'SELECT'),
                       ('sale_line_pricing_provenance', 'INSERT')) AS t(tbl, priv))
       AND NOT (SELECT bool_or(has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE'))
                  FROM (VALUES ('sale_line_pricing_provenance', 'origin'),
                               ('sale_line_pricing_provenance', 'price_event_id'),
                               ('sale_line_pricing_provenance', 'pricing_revision'),
                               ('sale_line_pricing_provenance', 'tenant_id')) AS c(tbl, col))
       AS domain_ok \gset

\if :domain_ok
  COMMIT;
  \echo 'OK: domain role holds every required sale-line pricing provenance grant.'
\else
  ROLLBACK;
  \echo 'FAILED: the domain role is missing a required grant or holds an UPDATE (see the tables above). Nothing was changed.'
  DO $$ BEGIN RAISE EXCEPTION 'sale-line pricing provenance domain grants incomplete'; END $$;
\endif
