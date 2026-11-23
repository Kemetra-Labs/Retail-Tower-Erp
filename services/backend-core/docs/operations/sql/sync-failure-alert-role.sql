-- Sync-failure alert role template (RT-1556, follow-up of RT-1034 S13).
-- See docs/operations/database-roles.md.
--
-- The worker's sync-failure alert sweep connects through
-- SYNC_FAILURE_ALERT_DATABASE_URL as this role instead of the shared
-- DATABASE_URL role, so the sweep itself holds no write grant on the posting,
-- reconciliation or sale tables.
--
-- Run ONCE per environment, by a superuser (or, on managed PostgreSQL, the
-- provider's admin user), AFTER `migrate up` has applied migration 0130 and
-- BEFORE SYNC_FAILURE_ALERT_ENABLED is set to true. It is NOT a routine
-- every-release script: its file name does not end in `-domain-grants.sql`, so
-- deploy/apply-domain-grants.sh never applies it. This file holds NO
-- credential. Give psql the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...), never as a URL argument, and pass the role
-- name:
--   psql -X -v alert_role=<role> -f docs/operations/sql/sync-failure-alert-role.sql
-- Then set the password from the secret manager in a separate, unlogged step,
-- never in this file, in shell history or in git:
--   \password <role>
-- (psql prompts and sends only a hash.) Store the resulting
-- SYNC_FAILURE_ALERT_DATABASE_URL in the secret manager like the other
-- database URLs.
--
-- The worker checks these grants at boot in production (and with
-- VERIFY_DATABASE_POOL_BOUNDARY=1) when SYNC_FAILURE_ALERT_DATABASE_URL is set
-- and refuses to start when a required grant is missing or any other
-- privilege is present (verifySyncFailureAlertRole in
-- apps/worker/src/database-role-verifier.ts, SYNC_FAILURE_ALERT_ROLE_GRANTS).
-- Keep this file and that list in step.
--
-- Never DELETE and never TRUNCATE (TRUNCATE is not subject to row security).
-- No write on erpnext_posting_status, sales or any reconciliation table.
-- The role has NOBYPASSRLS: every statement runs under FORCE RLS inside
-- runWithTenantContext. It is a member of no role.

\set ON_ERROR_STOP on

CREATE ROLE :"alert_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO :"alert_role";

-- Read: the failure state it observes and the recipients it resolves.
GRANT SELECT ON tenants, stores, sales, erpnext_posting_status,
                memberships, roles, store_access TO :"alert_role";
GRANT SELECT (id, email, deleted_at) ON users TO :"alert_role";

-- audit_events: INSERT (the alert's own audit rows) and SELECT (INSERT ... RETURNING
-- and the dedup reads). The table is append-only for every role.
GRANT SELECT, INSERT ON audit_events TO :"alert_role";

-- Its own tables: windows are opened and closed, deliveries are claimed and
-- moved claimed -> delivered / failed.
GRANT SELECT, INSERT, UPDATE ON sync_failure_alert_windows,
                                sync_failure_alert_deliveries TO :"alert_role";

-- Verify (run as any role): every row must read `t`, and the role must not
-- inherit grants from another role (NOINHERIT above; check pg_auth_members).
SELECT t.tbl, t.priv, has_table_privilege(:'alert_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('tenants', 'SELECT'), ('stores', 'SELECT'), ('sales', 'SELECT'),
               ('erpnext_posting_status', 'SELECT'), ('memberships', 'SELECT'),
               ('roles', 'SELECT'), ('store_access', 'SELECT'),
               ('audit_events', 'SELECT'), ('audit_events', 'INSERT'),
               ('sync_failure_alert_windows', 'SELECT'),
               ('sync_failure_alert_windows', 'INSERT'),
               ('sync_failure_alert_windows', 'UPDATE'),
               ('sync_failure_alert_deliveries', 'SELECT'),
               ('sync_failure_alert_deliveries', 'INSERT'),
               ('sync_failure_alert_deliveries', 'UPDATE')) AS t(tbl, priv);
