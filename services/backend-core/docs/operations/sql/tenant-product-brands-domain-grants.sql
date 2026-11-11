-- Domain-role grants for catalog brands (RT-1334, migration 0097).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0097 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on this table). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/tenant-product-brands-domain-grants.sql
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
-- with the boot check off, every brand list, create and rename (and every
-- product read, which joins the brand) fails with permission denied. The
-- table is FORCE ROW LEVEL SECURITY by tenant, so the grants give access only
-- inside runWithTenantContext.
--
-- tenant_product_brands: SELECT and INSERT table-level, and UPDATE on `name`
-- only (RT-1249 column grants): the Console lists, creates and renames brands,
-- so the domain role can never rewrite tenant_id, created_by or retired_at.
-- The updated_at trigger assigns NEW itself and needs no column privilege.
-- Never grant DELETE or TRUNCATE: there is no DELETE policy, and TRUNCATE is
-- not subject to row security. tenant_products.brand_id needs nothing new: the
-- domain role already reads and writes tenant_products.
--
-- The auth lookup role must hold NO privilege on the table
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's brands.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

BEGIN;

-- A table-level UPDATE would cover every column; clear it (and any wider column
-- UPDATE) so only the column below remains. SELECT and INSERT are untouched.
REVOKE UPDATE ON tenant_product_brands FROM :"domain_role";
GRANT SELECT, INSERT ON tenant_product_brands TO :"domain_role";
GRANT UPDATE (name) ON tenant_product_brands TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('tenant_product_brands', 'SELECT'),
               ('tenant_product_brands', 'INSERT')) AS t(tbl, priv);

SELECT has_column_privilege(:'domain_role', 'tenant_product_brands', 'name', 'UPDATE') AS name_update_granted;

-- No wider UPDATE: the other columns must read `f`.
SELECT c.col, has_column_privilege(:'domain_role', 'tenant_product_brands', c.col, 'UPDATE') AS granted
  FROM (VALUES ('tenant_id'), ('id'), ('created_by'), ('retired_at')) AS c(col);

SELECT (SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv))
          FROM (VALUES ('tenant_product_brands', 'SELECT'),
                       ('tenant_product_brands', 'INSERT')) AS t(tbl, priv))
       AND has_column_privilege(:'domain_role', 'tenant_product_brands', 'name', 'UPDATE')
       AND NOT (SELECT bool_or(has_column_privilege(:'domain_role', 'tenant_product_brands', c.col, 'UPDATE'))
                  FROM (VALUES ('tenant_id'), ('id'), ('created_by'), ('retired_at')) AS c(col))
       AS domain_ok \gset

\if :domain_ok
  COMMIT;
  \echo 'OK: domain role holds every required tenant_product_brands grant.'
\else
  ROLLBACK;
  \echo 'FAILED: the domain role is missing a required grant or holds a wider UPDATE (see the tables above). Nothing was changed.'
  DO $$ BEGIN RAISE EXCEPTION 'tenant_product_brands domain grants incomplete'; END $$;
\endif
