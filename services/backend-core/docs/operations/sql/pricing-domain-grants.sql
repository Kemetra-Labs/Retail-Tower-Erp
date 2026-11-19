-- Domain-role grants for the Retail Pricing tables (RT-1151, migration 0121;
-- change_sets.items_version / lines_version from migration 0123).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0121 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/pricing-domain-grants.sql
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
-- SELECT and INSERT table-level on all seven tables. UPDATE is column-level only
-- (the RT-1249 mechanism), on the columns the Pricing runtime (RT-1484) may
-- change; the 0121 guard triggers bound those changes further:
--   change_sets             the lifecycle columns (title, reason, state,
--                           version, the validation binding, the revision,
--                           the transition actors, and the content versions
--                           items_version / lines_version from 0123);
--   price_books             name;
--   price_zones             name and the retirement (retired_at,
--                           retired_by_user_id, retire_reason);
--   price_zone_memberships  ending a row (state, ended_in_revision);
--   price_events            ending a row (state, ended_in_revision).
-- The updated_at triggers assign NEW themselves and need no column privilege.
-- No UPDATE at all on pricing_revisions and pricing_revision_stores: they are
-- append-only (a trigger also refuses it for every role). Never grant DELETE or
-- TRUNCATE: there is no DELETE policy, TRUNCATE is not subject to row security,
-- and every pricing fact is kept.
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's prices.

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
REVOKE UPDATE ON change_sets, price_books, price_zones, pricing_revisions FROM :"domain_role";
REVOKE UPDATE ON pricing_revision_stores, price_zone_memberships, price_events FROM :"domain_role";
GRANT SELECT, INSERT ON change_sets, price_books, price_zones, pricing_revisions TO :"domain_role";
GRANT SELECT, INSERT ON pricing_revision_stores, price_zone_memberships, price_events TO :"domain_role";
GRANT UPDATE (title, reason, state, version, validated_at_revision, preview_hash, target_store_set_hash, sensitive, sensitivity_reasons, revision_no, submitted_by_user_id, submitted_at, approved_by_user_id, approved_at, published_by_user_id, published_at, cancelled_by_user_id, cancelled_at, rejected_by_user_id, rejected_at, rejection_reason, items_version, lines_version) ON change_sets TO :"domain_role";
GRANT UPDATE (name) ON price_books TO :"domain_role";
GRANT UPDATE (name, retired_at, retired_by_user_id, retire_reason) ON price_zones TO :"domain_role";
GRANT UPDATE (state, ended_in_revision) ON price_zone_memberships TO :"domain_role";
GRANT UPDATE (state, ended_in_revision) ON price_events TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('change_sets', 'SELECT'),
                ('change_sets', 'INSERT'),
                ('price_books', 'SELECT'),
                ('price_books', 'INSERT'),
                ('price_zones', 'SELECT'),
                ('price_zones', 'INSERT'),
                ('pricing_revisions', 'SELECT'),
                ('pricing_revisions', 'INSERT'),
                ('pricing_revision_stores', 'SELECT'),
                ('pricing_revision_stores', 'INSERT'),
                ('price_zone_memberships', 'SELECT'),
                ('price_zone_memberships', 'INSERT'),
                ('price_events', 'SELECT'),
                ('price_events', 'INSERT')) AS t(tbl, priv);

SELECT c.tbl, c.col, has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE') AS granted
  FROM (VALUES ('change_sets', 'title'),
                ('change_sets', 'reason'),
                ('change_sets', 'state'),
                ('change_sets', 'version'),
                ('change_sets', 'validated_at_revision'),
                ('change_sets', 'preview_hash'),
                ('change_sets', 'target_store_set_hash'),
                ('change_sets', 'sensitive'),
                ('change_sets', 'sensitivity_reasons'),
                ('change_sets', 'revision_no'),
                ('change_sets', 'submitted_by_user_id'),
                ('change_sets', 'submitted_at'),
                ('change_sets', 'approved_by_user_id'),
                ('change_sets', 'approved_at'),
                ('change_sets', 'published_by_user_id'),
                ('change_sets', 'published_at'),
                ('change_sets', 'cancelled_by_user_id'),
                ('change_sets', 'cancelled_at'),
                ('change_sets', 'rejected_by_user_id'),
                ('change_sets', 'rejected_at'),
                ('change_sets', 'rejection_reason'),
                ('change_sets', 'items_version'),
                ('change_sets', 'lines_version'),
                ('price_books', 'name'),
                ('price_zones', 'name'),
                ('price_zones', 'retired_at'),
                ('price_zones', 'retired_by_user_id'),
                ('price_zones', 'retire_reason'),
                ('price_zone_memberships', 'state'),
                ('price_zone_memberships', 'ended_in_revision'),
                ('price_events', 'state'),
                ('price_events', 'ended_in_revision')) AS c(tbl, col);

-- No wider UPDATE: the immutable columns must read `f`.
SELECT c.tbl, c.col, has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE') AS granted
  FROM (VALUES ('change_sets', 'tenant_id'),
                ('change_sets', 'kind'),
                ('change_sets', 'created_by_user_id'),
                ('price_books', 'currency_code'),
                ('price_books', 'tax_price_basis'),
                ('price_zones', 'is_default'),
                ('price_zones', 'price_book_id'),
                ('pricing_revisions', 'revision_no'),
                ('pricing_revision_stores', 'store_id'),
                ('price_zone_memberships', 'price_zone_id'),
                ('price_zone_memberships', 'effective_from'),
                ('price_events', 'price'),
                ('price_events', 'effective_from'),
                ('price_events', 'effective_from_local'),
                ('price_events', 'published_in_revision')) AS c(tbl, col);

SELECT (SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv))
          FROM (VALUES ('change_sets', 'SELECT'),
                        ('change_sets', 'INSERT'),
                        ('price_books', 'SELECT'),
                        ('price_books', 'INSERT'),
                        ('price_zones', 'SELECT'),
                        ('price_zones', 'INSERT'),
                        ('pricing_revisions', 'SELECT'),
                        ('pricing_revisions', 'INSERT'),
                        ('pricing_revision_stores', 'SELECT'),
                        ('pricing_revision_stores', 'INSERT'),
                        ('price_zone_memberships', 'SELECT'),
                        ('price_zone_memberships', 'INSERT'),
                        ('price_events', 'SELECT'),
                        ('price_events', 'INSERT')) AS t(tbl, priv))
       AND (SELECT bool_and(has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE'))
              FROM (VALUES ('change_sets', 'title'),
                            ('change_sets', 'reason'),
                            ('change_sets', 'state'),
                            ('change_sets', 'version'),
                            ('change_sets', 'validated_at_revision'),
                            ('change_sets', 'preview_hash'),
                            ('change_sets', 'target_store_set_hash'),
                            ('change_sets', 'sensitive'),
                            ('change_sets', 'sensitivity_reasons'),
                            ('change_sets', 'revision_no'),
                            ('change_sets', 'submitted_by_user_id'),
                            ('change_sets', 'submitted_at'),
                            ('change_sets', 'approved_by_user_id'),
                            ('change_sets', 'approved_at'),
                            ('change_sets', 'published_by_user_id'),
                            ('change_sets', 'published_at'),
                            ('change_sets', 'cancelled_by_user_id'),
                            ('change_sets', 'cancelled_at'),
                            ('change_sets', 'rejected_by_user_id'),
                            ('change_sets', 'rejected_at'),
                            ('change_sets', 'rejection_reason'),
                            ('change_sets', 'items_version'),
                            ('change_sets', 'lines_version'),
                            ('price_books', 'name'),
                            ('price_zones', 'name'),
                            ('price_zones', 'retired_at'),
                            ('price_zones', 'retired_by_user_id'),
                            ('price_zones', 'retire_reason'),
                            ('price_zone_memberships', 'state'),
                            ('price_zone_memberships', 'ended_in_revision'),
                            ('price_events', 'state'),
                            ('price_events', 'ended_in_revision')) AS c(tbl, col))
       AND NOT (SELECT bool_or(has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE'))
                  FROM (VALUES ('change_sets', 'tenant_id'),
                                ('change_sets', 'kind'),
                                ('change_sets', 'created_by_user_id'),
                                ('price_books', 'currency_code'),
                                ('price_books', 'tax_price_basis'),
                                ('price_zones', 'is_default'),
                                ('price_zones', 'price_book_id'),
                                ('pricing_revisions', 'revision_no'),
                                ('pricing_revision_stores', 'store_id'),
                                ('price_zone_memberships', 'price_zone_id'),
                                ('price_zone_memberships', 'effective_from'),
                                ('price_events', 'price'),
                                ('price_events', 'effective_from'),
                                ('price_events', 'effective_from_local'),
                                ('price_events', 'published_in_revision')) AS c(tbl, col))
       AS domain_ok \gset

\if :domain_ok
  COMMIT;
  \echo 'OK: domain role holds every required Pricing grant.'
\else
  ROLLBACK;
  \echo 'FAILED: the domain role is missing a required grant or holds a wider UPDATE (see the tables above). Nothing was changed.'
  DO $$ BEGIN RAISE EXCEPTION 'Pricing domain grants incomplete'; END $$;
\endif
