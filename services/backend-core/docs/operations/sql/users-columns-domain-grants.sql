-- Domain-role column grants on users (RT-1249, from RT-147 probe 5; owner
-- approval recorded on RT-1249). See docs/operations/database-roles.md.
--
-- users has no row security, so a table-level SELECT or UPDATE lets the domain
-- role read or overwrite every tenant's password hashes. Only the auth lookup
-- role needs users.password_hash (sign-in, rehash, reset). This script replaces
-- the domain role's table-level SELECT, INSERT and UPDATE on users with
-- column grants for exactly the columns domain code uses:
--   SELECT: id, email, display_name, is_platform_admin, deleted_at
--   INSERT: id, email, display_name, email_verified_at (RT-937: a user created
--           by accepting an invitation; it has no local password)
-- No UPDATE: no domain code updates users. The table-wide DELETE is left as it
-- is (a separate owner decision, RT-1249).
--
-- Run as the migration owner (or any role allowed to grant on users). This
-- file holds NO credential. Give psql the connection through libpq environment
-- variables (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example),
-- never as a URL argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/users-columns-domain-grants.sql
-- deploy/apply-domain-grants.sh runs this in step 2 of every release
-- (deploy/README.md), selected by the marker on the next line (RT-812):
-- deploy: every-release
--
-- Idempotent. The change runs in one transaction, and the verification below
-- runs before COMMIT: if it finds a missing grant, or any path left to
-- password_hash (a grant to PUBLIC, an inherited role, a role the domain role
-- can SET ROLE to), the script exits non-zero and nothing is changed.
--
-- With this applied, the API refuses to boot in production if the domain role
-- can still SELECT, INSERT or UPDATE users.password_hash
-- (DOMAIN_FORBIDDEN_COLUMN_GRANTS, apps/api/src/auth/database-pools.ts), or
-- lacks a column grant below (DOMAIN_REQUIRED_COLUMN_GRANTS).
--
-- Rolling the API back to a release from before RT-1249: that release's boot
-- check requires table-level INSERT on users, which this script removes, so it
-- refuses to boot. Run users-columns-rollback.sql first (it re-opens the RT-147
-- finding until this script runs again); deploy/README.md has the steps.

\set ON_ERROR_STOP on

-- The domain role must be named explicitly: guessing a default could grant to
-- a role that DATABASE_URL does not use and still report success.
\if :{?domain_role}
\else
  \echo 'FAILED: pass -v domain_role=<the DATABASE_URL role name>.'
  DO $$ BEGIN RAISE EXCEPTION 'domain_role not set'; END $$;
\endif

BEGIN;

-- Revoking a table-level privilege also revokes it on every column, so this
-- clears any earlier column grant too; the GRANTs below then set the list.
REVOKE SELECT, INSERT, UPDATE ON users FROM :"domain_role";
GRANT SELECT (id, email, display_name, is_platform_admin, deleted_at) ON users TO :"domain_role";
GRANT INSERT (id, email, display_name, email_verified_at) ON users TO :"domain_role";

-- Verify the domain role. Required rows must read `t`; password_hash rows
-- must read `f`. `reachable` also counts a role the domain role is a member
-- of, even without INHERIT (SET ROLE reaches it), as the API boot check does.
SELECT t.col, t.priv, t.expected,
       has_column_privilege(:'domain_role', 'users', t.col, t.priv)
       OR EXISTS (
         SELECT 1 FROM pg_roles g
          WHERE g.rolname <> :'domain_role'
            AND pg_has_role(:'domain_role', g.oid, 'MEMBER')
            AND has_column_privilege(g.oid, 'users', t.col, t.priv)
       ) AS reachable
  FROM (VALUES
    ('id', 'SELECT', true),
    ('email', 'SELECT', true),
    ('display_name', 'SELECT', true),
    ('is_platform_admin', 'SELECT', true),
    ('deleted_at', 'SELECT', true),
    ('id', 'INSERT', true),
    ('email', 'INSERT', true),
    ('display_name', 'INSERT', true),
    ('email_verified_at', 'INSERT', true),
    ('password_hash', 'SELECT', false),
    ('password_hash', 'INSERT', false),
    ('password_hash', 'UPDATE', false)
  ) AS t(col, priv, expected);

SELECT bool_and(
         CASE WHEN t.expected
              THEN has_column_privilege(:'domain_role', 'users', t.col, t.priv)
              ELSE NOT (
                has_column_privilege(:'domain_role', 'users', t.col, t.priv)
                OR EXISTS (
                  SELECT 1 FROM pg_roles g
                   WHERE g.rolname <> :'domain_role'
                     AND pg_has_role(:'domain_role', g.oid, 'MEMBER')
                     AND has_column_privilege(g.oid, 'users', t.col, t.priv)
                )
              )
         END
       ) AS domain_ok
  FROM (VALUES
    ('id', 'SELECT', true),
    ('email', 'SELECT', true),
    ('display_name', 'SELECT', true),
    ('is_platform_admin', 'SELECT', true),
    ('deleted_at', 'SELECT', true),
    ('id', 'INSERT', true),
    ('email', 'INSERT', true),
    ('display_name', 'INSERT', true),
    ('email_verified_at', 'INSERT', true),
    ('password_hash', 'SELECT', false),
    ('password_hash', 'INSERT', false),
    ('password_hash', 'UPDATE', false)
  ) AS t(col, priv, expected) \gset

\if :domain_ok
  COMMIT;
  \echo 'OK: the domain role holds the users column grants and cannot reach password_hash.'
\else
  ROLLBACK;
  \echo 'FAILED: see the table above. A password_hash row reading t comes from a grant to PUBLIC or to a role the domain role belongs to (see \\dp users and \\drg <role>): revoke it there. Nothing was changed.'
  DO $$ BEGIN RAISE EXCEPTION 'users column grants incomplete, or password_hash still reachable'; END $$;
\endif
