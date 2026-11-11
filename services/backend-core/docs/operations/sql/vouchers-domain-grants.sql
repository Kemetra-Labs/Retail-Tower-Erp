-- Domain-role grants for voucher issuance (RT-1107, migration 0091).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0091 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/vouchers-domain-grants.sql
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
-- with the boot check off, every voucher issue, read and cancel fails with
-- permission denied. Both tables are FORCE ROW LEVEL SECURITY by tenant, so
-- the grants give access only inside runWithTenantContext.
--
-- vouchers: SELECT, INSERT and UPDATE. Issue inserts, the console reads, and
-- cancel (and later redeem) is a conditional UPDATE of the status (0091 has
-- SELECT, INSERT and UPDATE tenant policies). voucher_eligible_stores: SELECT
-- and INSERT only (the eligible set is fixed at issue; no UPDATE policy).
-- Never grant DELETE or TRUNCATE on either: there is no DELETE policy, and
-- TRUNCATE is not subject to row security.
--
-- The auth lookup role must hold NO privilege on either table
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's rows.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

GRANT SELECT, INSERT, UPDATE ON vouchers TO :"domain_role";
GRANT SELECT, INSERT ON voucher_eligible_stores TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('vouchers', 'SELECT'),
               ('vouchers', 'INSERT'),
               ('vouchers', 'UPDATE'),
               ('voucher_eligible_stores', 'SELECT'),
               ('voucher_eligible_stores', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('vouchers', 'SELECT'),
               ('vouchers', 'INSERT'),
               ('vouchers', 'UPDATE'),
               ('voucher_eligible_stores', 'SELECT'),
               ('voucher_eligible_stores', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required voucher grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'voucher domain grants incomplete'; END $$;
\endif
