-- OWNER-RUN RECOVERY ONLY (RT-1249). Never part of a routine deploy: it has no
-- deploy marker, and its name is not *-domain-grants.sql.
--
-- Use it only to boot an API release from before RT-1249 after
-- users-columns-domain-grants.sql has run, for example after an app-only
-- revert (deploy/README.md). Such a release's boot check requires table-level
-- INSERT on users, and its invitation code reads and inserts whole users rows.
--
-- It gives the domain role table-level SELECT and INSERT on users back, which
-- RE-OPENS THE RT-147 FINDING: the domain role can read every tenant's
-- password hash again, and insert users rows with any column value, including
-- is_platform_admin = true and a chosen password_hash (the table-level INSERT
-- every release before RT-1249 had). UPDATE is not restored; no release needs
-- it. Leave it in place only while a pre-RT-1249 release runs. Run
-- users-columns-domain-grants.sql BEFORE starting a release from RT-1249 on
-- (a normal deploy does so in step 2): that release's boot check refuses to
-- start while these grants are in place.
--
-- Run as the migration owner, with the connection in libpq environment
-- variables (never a URL argument):
--   psql -X -v domain_role=<role> -f docs/operations/sql/users-columns-rollback.sql

\set ON_ERROR_STOP on

\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT ON users TO :"domain_role";

SELECT has_table_privilege(:'domain_role', 'users', 'SELECT')
   AND has_table_privilege(:'domain_role', 'users', 'INSERT') AS rollback_ok \gset

\if :rollback_ok
  \echo 'OK: pre-RT-1249 users grants restored. password_hash is readable by the domain role until users-columns-domain-grants.sql runs again.'
\else
  \echo 'FAILED: the domain role still lacks table-level SELECT or INSERT on users.'
  DO $$ BEGIN RAISE EXCEPTION 'users rollback grants incomplete'; END $$;
\endif
