-- Domain-role grants for the Price Change Set content tables (RT-1151,
-- migration 0123). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0123 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/price-change-set-content-domain-grants.sql
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
-- tables are FORCE ROW LEVEL SECURITY by tenant, so the grants give access only
-- inside runWithTenantContext.
--
-- SELECT and INSERT table-level on all six tables. The only UPDATE is
-- column-level (the RT-1249 mechanism): price_change_set_lines (new_event_id,
-- result_ids), the publish record the 0123 guard lets the publishing
-- transaction set once. Everything else is insert-only (a trigger also refuses
-- UPDATE for every role). Never grant DELETE or TRUNCATE: there is no DELETE
-- policy, TRUNCATE is not subject to row security, and a set's content is kept.
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's pricing work.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

BEGIN;

-- A table-level UPDATE would cover every column; clear it so only the columns
-- below remain. SELECT and INSERT are untouched.
REVOKE UPDATE ON price_change_set_item_lists, price_change_set_items, price_change_set_validations FROM :"domain_role";
REVOKE UPDATE ON price_change_set_lines, price_change_set_preview_lines, price_change_set_preview_memberships FROM :"domain_role";
GRANT SELECT, INSERT ON price_change_set_item_lists, price_change_set_items, price_change_set_validations TO :"domain_role";
GRANT SELECT, INSERT ON price_change_set_lines, price_change_set_preview_lines, price_change_set_preview_memberships TO :"domain_role";
GRANT UPDATE (new_event_id, result_ids) ON price_change_set_lines TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES
                ('price_change_set_item_lists', 'SELECT'),
                ('price_change_set_item_lists', 'INSERT'),
                ('price_change_set_items', 'SELECT'),
                ('price_change_set_items', 'INSERT'),
                ('price_change_set_validations', 'SELECT'),
                ('price_change_set_validations', 'INSERT'),
                ('price_change_set_lines', 'SELECT'),
                ('price_change_set_lines', 'INSERT'),
                ('price_change_set_preview_lines', 'SELECT'),
                ('price_change_set_preview_lines', 'INSERT'),
                ('price_change_set_preview_memberships', 'SELECT'),
                ('price_change_set_preview_memberships', 'INSERT')) AS t(tbl, priv);

SELECT c.col, has_column_privilege(:'domain_role', 'price_change_set_lines', c.col, 'UPDATE') AS granted
  FROM (VALUES ('new_event_id'), ('result_ids')) AS c(col);

-- No wider UPDATE: every column of the six tables but lines.new_event_id and
-- lines.result_ids; this must return no row.
SELECT c.relname AS tbl, a.attname AS col
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relname IN ('price_change_set_item_lists', 'price_change_set_items', 'price_change_set_validations',
                     'price_change_set_lines', 'price_change_set_preview_lines', 'price_change_set_preview_memberships')
   AND NOT (c.relname = 'price_change_set_lines' AND a.attname IN ('new_event_id', 'result_ids'))
   AND has_column_privilege(:'domain_role', c.oid, a.attnum, 'UPDATE');

SELECT (SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv))
          FROM (VALUES
                        ('price_change_set_item_lists', 'SELECT'),
                        ('price_change_set_item_lists', 'INSERT'),
                        ('price_change_set_items', 'SELECT'),
                        ('price_change_set_items', 'INSERT'),
                        ('price_change_set_validations', 'SELECT'),
                        ('price_change_set_validations', 'INSERT'),
                        ('price_change_set_lines', 'SELECT'),
                        ('price_change_set_lines', 'INSERT'),
                        ('price_change_set_preview_lines', 'SELECT'),
                        ('price_change_set_preview_lines', 'INSERT'),
                        ('price_change_set_preview_memberships', 'SELECT'),
                        ('price_change_set_preview_memberships', 'INSERT')) AS t(tbl, priv))
       AND has_column_privilege(:'domain_role', 'price_change_set_lines', 'new_event_id', 'UPDATE')
       AND has_column_privilege(:'domain_role', 'price_change_set_lines', 'result_ids', 'UPDATE')
       AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
              WHERE c.relnamespace = 'public'::regnamespace
                AND c.relname IN ('price_change_set_item_lists', 'price_change_set_items', 'price_change_set_validations',
                                  'price_change_set_lines', 'price_change_set_preview_lines',
                                  'price_change_set_preview_memberships')
                AND NOT (c.relname = 'price_change_set_lines' AND a.attname IN ('new_event_id', 'result_ids'))
                AND has_column_privilege(:'domain_role', c.oid, a.attnum, 'UPDATE'))
       AS domain_ok \gset

\if :domain_ok
  COMMIT;
  \echo 'OK: domain role holds every required Price Change Set content grant.'
\else
  ROLLBACK;
  \echo 'FAILED: the domain role is missing a required grant or holds a wider UPDATE (see the tables above). Nothing was changed.'
  DO $$ BEGIN RAISE EXCEPTION 'Price Change Set content domain grants incomplete'; END $$;
\endif
