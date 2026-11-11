-- Domain-role grants for the POS sale quarantine (RT-1312 Phase 3(b),
-- migration 0093). See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0093 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on this table). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/sale-quarantine-items-domain-grants.sql
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
-- with the boot check off, every quarantine upload, Console read, repair and
-- write-off fails with permission denied. The table is FORCE ROW LEVEL
-- SECURITY by tenant, so the grants give access only inside
-- runWithTenantContext.
--
-- sale_quarantine_items: SELECT and INSERT table-level, and UPDATE on the
-- mutable columns only (RT-1249 column grants): the upload conflict count,
-- the state and its resolution, sale, repair and write-off columns, and the
-- body and its purge time (decision P3 retention). The domain role can
-- therefore never rewrite the provenance, the till's claim, the facts digest,
-- the summary, the tenant, store or devices. The updated_at trigger assigns
-- NEW itself and needs no column privilege. Never grant DELETE or TRUNCATE:
-- there is no DELETE policy, and TRUNCATE is not subject to row security.
--
-- The auth lookup role must hold NO privilege on the table
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
-- UPDATE) so only the list below remains. SELECT and INSERT are untouched.
REVOKE UPDATE ON sale_quarantine_items FROM :"domain_role";
GRANT SELECT, INSERT ON sale_quarantine_items TO :"domain_role";
GRANT UPDATE (upload_conflict_count, state, resolved_at, sale_id, repair_count, last_repair_at, last_repair_outcome, last_repair_http_status, last_repair_error_code, write_off_note, sale_body, body_purged_at) ON sale_quarantine_items TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.priv, has_table_privilege(:'domain_role', 'sale_quarantine_items', t.priv) AS granted
  FROM (VALUES ('SELECT'), ('INSERT')) AS t(priv);

SELECT c.col, has_column_privilege(:'domain_role', 'sale_quarantine_items', c.col, 'UPDATE') AS granted
  FROM (VALUES ('upload_conflict_count'), ('state'), ('resolved_at'), ('sale_id'), ('repair_count'),
               ('last_repair_at'), ('last_repair_outcome'), ('last_repair_http_status'),
               ('last_repair_error_code'), ('write_off_note'), ('sale_body'), ('body_purged_at')) AS c(col);

-- No wider UPDATE: the write-once columns must read `f`.
SELECT c.col, has_column_privilege(:'domain_role', 'sale_quarantine_items', c.col, 'UPDATE') AS granted
  FROM (VALUES ('tenant_id'), ('store_id'), ('device_id'), ('previous_terminal_id'), ('source_system'),
               ('external_id'), ('idempotency_key'), ('reason_kind'), ('till_http_status'),
               ('facts_digest'), ('summary_pos_total'), ('received_at')) AS c(col);

SELECT (SELECT bool_and(has_table_privilege(:'domain_role', 'sale_quarantine_items', t.priv))
          FROM (VALUES ('SELECT'), ('INSERT')) AS t(priv))
       AND (SELECT bool_and(has_column_privilege(:'domain_role', 'sale_quarantine_items', c.col, 'UPDATE'))
              FROM (VALUES ('upload_conflict_count'), ('state'), ('resolved_at'), ('sale_id'), ('repair_count'),
                           ('last_repair_at'), ('last_repair_outcome'), ('last_repair_http_status'),
                           ('last_repair_error_code'), ('write_off_note'), ('sale_body'), ('body_purged_at')) AS c(col))
       AND NOT (SELECT bool_or(has_column_privilege(:'domain_role', 'sale_quarantine_items', c.col, 'UPDATE'))
                  FROM (VALUES ('tenant_id'), ('store_id'), ('device_id'), ('previous_terminal_id'), ('source_system'),
                               ('external_id'), ('idempotency_key'), ('reason_kind'), ('till_http_status'),
                               ('facts_digest'), ('summary_pos_total'), ('received_at')) AS c(col))
       AS domain_ok \gset

\if :domain_ok
  COMMIT;
  \echo 'OK: domain role holds every required sale quarantine grant.'
\else
  ROLLBACK;
  \echo 'FAILED: the domain role is missing a required grant or holds a wider UPDATE (see the tables above). Nothing was changed.'
  DO $$ BEGIN RAISE EXCEPTION 'sale quarantine domain grants incomplete'; END $$;
\endif
