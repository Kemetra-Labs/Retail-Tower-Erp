-- Domain-role grants for Tracking Identity birth and the per-identity
-- Inventory Anchor (RT-453, migration 0103). See
-- docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0103 and BEFORE the
-- API and worker images that need it are rolled, as the migration owner (or
-- any role allowed to grant on these tables). This file holds NO credential.
-- Give psql the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/tracking-identity-birth-domain-grants.sql
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
-- with the boot check off, identity birth and the anchor fail with permission
-- denied. Every table is FORCE ROW LEVEL SECURITY by tenant, so the grants
-- give access only inside runWithTenantContext.
--
-- tracking_identities, erpnext_tracking_map: INSERT (identity birth from ERP
-- evidence, 0045's INSERT policies; SELECT is already granted).
-- tracking_identity_births, erp_stock_import_row_resolutions,
-- inventory_identity_anchors, inventory_identity_anchor_lines: SELECT, INSERT.
-- Append-only records.
-- Never grant UPDATE, DELETE or TRUNCATE on the new tables: none has an UPDATE
-- or DELETE policy, and TRUNCATE is not subject to row security.
--
-- The auth lookup role must hold NO privilege on the new tables
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

GRANT INSERT ON tracking_identities TO :"domain_role";
GRANT INSERT ON erpnext_tracking_map TO :"domain_role";
GRANT SELECT, INSERT ON tracking_identity_births TO :"domain_role";
GRANT SELECT, INSERT ON erp_stock_import_row_resolutions TO :"domain_role";
GRANT SELECT, INSERT ON inventory_identity_anchors TO :"domain_role";
GRANT SELECT, INSERT ON inventory_identity_anchor_lines TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('tracking_identities', 'INSERT'),
               ('erpnext_tracking_map', 'INSERT'),
               ('tracking_identity_births', 'SELECT'),
               ('tracking_identity_births', 'INSERT'),
               ('erp_stock_import_row_resolutions', 'SELECT'),
               ('erp_stock_import_row_resolutions', 'INSERT'),
               ('inventory_identity_anchors', 'SELECT'),
               ('inventory_identity_anchors', 'INSERT'),
               ('inventory_identity_anchor_lines', 'SELECT'),
               ('inventory_identity_anchor_lines', 'INSERT')) AS t(tbl, priv);

SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv)) AS domain_ok
  FROM (VALUES ('tracking_identities', 'INSERT'),
               ('erpnext_tracking_map', 'INSERT'),
               ('tracking_identity_births', 'SELECT'),
               ('tracking_identity_births', 'INSERT'),
               ('erp_stock_import_row_resolutions', 'SELECT'),
               ('erp_stock_import_row_resolutions', 'INSERT'),
               ('inventory_identity_anchors', 'SELECT'),
               ('inventory_identity_anchors', 'INSERT'),
               ('inventory_identity_anchor_lines', 'SELECT'),
               ('inventory_identity_anchor_lines', 'INSERT')) AS t(tbl, priv) \gset

\if :domain_ok
  \echo 'OK: domain role holds every required tracking identity birth grant.'
\else
  \echo 'FAILED: the domain role is missing a required grant (see the table above).'
  DO $$ BEGIN RAISE EXCEPTION 'Tracking identity birth domain grants incomplete'; END $$;
\endif
