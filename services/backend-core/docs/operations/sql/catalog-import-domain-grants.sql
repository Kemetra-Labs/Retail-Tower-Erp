-- Domain-role grants for the manual product import tables (RT-1503,
-- migration 0124, spec 049 S2). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0124 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/catalog-import-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
-- Optionally also pass -v lookup_role=<AUTH_LOOKUP_DATABASE_URL role> to check
-- that the lookup role holds no privilege of any kind on these tables (table or
-- column level), so a release stops here instead of at API boot.
--
-- The script stops on the first error and exits non-zero (ON_ERROR_STOP), and
-- also exits non-zero if the verification below finds a missing grant, a
-- forbidden one or a lookup-role privilege, so deployment automation cannot
-- accept a failed step.
--
-- Every name is the public schema's: the checks and REVOKEs name public.<table>,
-- and the GRANTs (which the RT-812 grant oracle reads unqualified) run under a
-- search_path pinned to pg_catalog, public, pg_temp, so no other schema (and no
-- temporary table) on the session's search_path can take their place.
--
-- Without these grants the API refuses to boot in production
-- (DOMAIN_REQUIRED_GRANTS in apps/api/src/auth/database-pools.ts, RT-212). The
-- tables are FORCE ROW LEVEL SECURITY by tenant, so the grants give access only
-- inside runWithTenantContext.
--
-- catalog_import_mapping_profiles: SELECT, INSERT, UPDATE (saving a profile
--   upserts by name and keeps the id).
-- catalog_import_batches: SELECT, INSERT, UPDATE. Never DELETE: there is no
--   DELETE policy and a 0124 trigger refuses DELETE and TRUNCATE for every
--   role; the batch is the lasting import summary.
-- catalog_import_rows: SELECT, INSERT, UPDATE, DELETE. DELETE is for the
--   re-upload (the old file's rows) and the retention purge (OD-6).
-- Never grant TRUNCATE on any of them (TRUNCATE is not subject to row
-- security), nor DELETE on the batches or the profiles.
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's staged catalogue rows.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

BEGIN;

-- The unqualified GRANTs below resolve in public only (pg_temp last, never first).
SET LOCAL search_path = pg_catalog, public, pg_temp;

-- A DELETE or TRUNCATE granted by hand earlier would survive the GRANTs below: clear the ones never allowed.
REVOKE DELETE, TRUNCATE ON public.catalog_import_mapping_profiles, public.catalog_import_batches FROM :"domain_role";
REVOKE TRUNCATE ON public.catalog_import_rows FROM :"domain_role";
GRANT SELECT, INSERT, UPDATE ON catalog_import_mapping_profiles, catalog_import_batches TO :"domain_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_import_rows TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('public.catalog_import_mapping_profiles', 'SELECT'),
               ('public.catalog_import_mapping_profiles', 'INSERT'),
               ('public.catalog_import_mapping_profiles', 'UPDATE'),
               ('public.catalog_import_batches', 'SELECT'),
               ('public.catalog_import_batches', 'INSERT'),
               ('public.catalog_import_batches', 'UPDATE'),
               ('public.catalog_import_rows', 'SELECT'),
               ('public.catalog_import_rows', 'INSERT'),
               ('public.catalog_import_rows', 'UPDATE'),
               ('public.catalog_import_rows', 'DELETE')) AS t(tbl, priv);

SELECT (SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv))
          FROM (VALUES ('public.catalog_import_mapping_profiles', 'SELECT'),
                       ('public.catalog_import_mapping_profiles', 'INSERT'),
                       ('public.catalog_import_mapping_profiles', 'UPDATE'),
                       ('public.catalog_import_batches', 'SELECT'),
                       ('public.catalog_import_batches', 'INSERT'),
                       ('public.catalog_import_batches', 'UPDATE'),
                       ('public.catalog_import_rows', 'SELECT'),
                       ('public.catalog_import_rows', 'INSERT'),
                       ('public.catalog_import_rows', 'UPDATE'),
                       ('public.catalog_import_rows', 'DELETE')) AS t(tbl, priv))
       AND NOT has_table_privilege(:'domain_role', 'public.catalog_import_mapping_profiles', 'DELETE')
       AND NOT has_table_privilege(:'domain_role', 'public.catalog_import_batches', 'DELETE')
       AND NOT has_table_privilege(:'domain_role', 'public.catalog_import_mapping_profiles', 'TRUNCATE')
       AND NOT has_table_privilege(:'domain_role', 'public.catalog_import_batches', 'TRUNCATE')
       AND NOT has_table_privilege(:'domain_role', 'public.catalog_import_rows', 'TRUNCATE')
       AS domain_ok \gset

\if :domain_ok
  COMMIT;
  \echo 'OK: domain role holds every required catalog import grant and no DELETE on batches or profiles.'
\else
  ROLLBACK;
  \echo 'FAILED: the domain role is missing a required grant or holds DELETE / TRUNCATE it must not (see the table above). Nothing was changed.'
  DO $$ BEGIN RAISE EXCEPTION 'catalog import domain grants incomplete'; END $$;
\endif

-- Optional: the lookup role must hold no privilege of any kind on these tables,
-- table-level or on any column (a column SELECT on catalog_import_rows.cells
-- would expose every tenant's staged rows: the role has BYPASSRLS).
\if :{?lookup_role}
  SELECT NOT bool_or(has_table_privilege(:'lookup_role', t.tbl, p.priv)) AS lookup_table_ok
    FROM (VALUES ('public.catalog_import_mapping_profiles'), ('public.catalog_import_batches'),
                 ('public.catalog_import_rows')) AS t(tbl)
   CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv) \gset
  SELECT NOT bool_or(has_any_column_privilege(:'lookup_role', t.tbl, p.priv)) AS lookup_column_ok
    FROM (VALUES ('public.catalog_import_mapping_profiles'), ('public.catalog_import_batches'),
                 ('public.catalog_import_rows')) AS t(tbl)
   CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv) \gset
  \if :lookup_table_ok
    \if :lookup_column_ok
      \echo 'OK: lookup role holds no privilege on the catalog import tables.'
    \else
      \echo 'FAILED: the lookup role holds a column privilege on a catalog import table.'
      DO $$ BEGIN RAISE EXCEPTION 'lookup role holds a catalog import column privilege'; END $$;
    \endif
  \else
    \echo 'FAILED: the lookup role holds a privilege on a catalog import table.'
    DO $$ BEGIN RAISE EXCEPTION 'lookup role holds a catalog import privilege'; END $$;
  \endif
\endif
