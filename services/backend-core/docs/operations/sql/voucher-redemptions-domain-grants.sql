-- Domain-role grants for voucher redemption (RT-1111, migration 0092).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0092 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/voucher-redemptions-domain-grants.sql
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
-- with the boot check off, every voucher validate, redeem and reverse fails
-- with permission denied. Both tables are FORCE ROW LEVEL SECURITY by tenant,
-- so the grants give access only inside runWithTenantContext.
--
-- voucher_redemption_intents: SELECT and INSERT table-level, and UPDATE on one
-- column only (consumed_at; RT-1249 column grants). Validate inserts, redeem
-- reads the intent and consumes it by a conditional UPDATE of that column.
-- voucher_redemptions: SELECT and INSERT table-level, and UPDATE on two
-- columns only (reversed_at, reversed_by_device_id). Redeem inserts, reverse
-- is a conditional UPDATE of those columns. The domain role can therefore
-- never rewrite an amount, a token hash or a voucher id. The updated_at
-- trigger assigns NEW itself and needs no column privilege. Never grant
-- DELETE or TRUNCATE on either: there is no DELETE policy, and TRUNCATE is not
-- subject to row security.
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

BEGIN;

-- A table-level UPDATE would cover every column; clear it (and any wider column
-- UPDATE) so only the lists below remain. SELECT and INSERT are untouched.
REVOKE UPDATE ON voucher_redemption_intents FROM :"domain_role";
REVOKE UPDATE ON voucher_redemptions FROM :"domain_role";
GRANT SELECT, INSERT ON voucher_redemption_intents TO :"domain_role";
GRANT UPDATE (consumed_at) ON voucher_redemption_intents TO :"domain_role";
GRANT SELECT, INSERT ON voucher_redemptions TO :"domain_role";
GRANT UPDATE (reversed_at, reversed_by_device_id) ON voucher_redemptions TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('voucher_redemption_intents', 'SELECT'),
               ('voucher_redemption_intents', 'INSERT'),
               ('voucher_redemptions', 'SELECT'),
               ('voucher_redemptions', 'INSERT')) AS t(tbl, priv);

SELECT c.tbl, c.col, has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE') AS granted
  FROM (VALUES ('voucher_redemption_intents', 'consumed_at'),
               ('voucher_redemptions', 'reversed_at'),
               ('voucher_redemptions', 'reversed_by_device_id')) AS c(tbl, col);

-- No wider UPDATE: the immutable columns must read `f`.
SELECT c.tbl, c.col, has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE') AS granted
  FROM (VALUES ('voucher_redemption_intents', 'applied_amount_minor'),
               ('voucher_redemption_intents', 'token_hash'),
               ('voucher_redemption_intents', 'expires_at'),
               ('voucher_redemption_intents', 'tenant_id'),
               ('voucher_redemptions', 'applied_amount_minor'),
               ('voucher_redemptions', 'intent_id'),
               ('voucher_redemptions', 'voucher_id'),
               ('voucher_redemptions', 'tenant_id')) AS c(tbl, col);

SELECT (SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv))
          FROM (VALUES ('voucher_redemption_intents', 'SELECT'),
                       ('voucher_redemption_intents', 'INSERT'),
                       ('voucher_redemptions', 'SELECT'),
                       ('voucher_redemptions', 'INSERT')) AS t(tbl, priv))
       AND (SELECT bool_and(has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE'))
              FROM (VALUES ('voucher_redemption_intents', 'consumed_at'),
                           ('voucher_redemptions', 'reversed_at'),
                           ('voucher_redemptions', 'reversed_by_device_id')) AS c(tbl, col))
       AND NOT (SELECT bool_or(has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE'))
                  FROM (VALUES ('voucher_redemption_intents', 'applied_amount_minor'),
                               ('voucher_redemption_intents', 'token_hash'),
                               ('voucher_redemption_intents', 'expires_at'),
                               ('voucher_redemption_intents', 'tenant_id'),
                               ('voucher_redemptions', 'applied_amount_minor'),
                               ('voucher_redemptions', 'intent_id'),
                               ('voucher_redemptions', 'voucher_id'),
                               ('voucher_redemptions', 'tenant_id')) AS c(tbl, col))
       AS domain_ok \gset

\if :domain_ok
  COMMIT;
  \echo 'OK: domain role holds every required voucher redemption grant.'
\else
  ROLLBACK;
  \echo 'FAILED: the domain role is missing a required grant or holds a wider UPDATE (see the tables above). Nothing was changed.'
  DO $$ BEGIN RAISE EXCEPTION 'voucher redemption domain grants incomplete'; END $$;
\endif
