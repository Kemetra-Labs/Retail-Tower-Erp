-- Domain-role grants for the Offer Engine V1 tables (RT-1336, migration 0101).
-- See docs/operations/database-roles.md.
--
-- Run ONCE per environment, AFTER `migrate up` has applied 0101 and BEFORE the
-- API image that needs it is rolled, as the migration owner (or any role
-- allowed to grant on these tables). This file holds NO credential. Give psql
-- the connection through libpq environment variables
-- (PGHOST/PGUSER/PGPASSWORD/...; see deploy/grants.env.example), never as a URL
-- argument, and pass the environment's DATABASE_URL role name:
--   psql -X -v domain_role=<role> \
--        -f docs/operations/sql/offer-engine-domain-grants.sql
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
-- SELECT and INSERT table-level on all ten tables. UPDATE is column-level only
-- (the RT-1249 mechanism), on the columns the Offer Engine runtime (RT-1337)
-- may change; the 0101 guard triggers bound those changes further:
--   offers                        the draft (draft_revision, draft_definition,
--                                 draft_updated_at, draft_updated_by_user_id),
--                                 the end (ended_at, ended_by_user_id) and the
--                                 archive (archived_at, archived_by_user_id);
--   offer_pauses                  the resume (resumed_at, resumed_by_user_id);
--   offer_pack_store_revisions    applied_revision;
--   offer_pack_eligible_products  to_revision (closing a materialised row).
-- The updated_at triggers assign NEW themselves and need no column privilege.
-- No UPDATE at all on offer_versions, offer_version_stores, offer_version_rules,
-- offer_pack_revisions, sale_line_promotions and
-- sale_return_promotion_clawbacks: they are append-only (a trigger also refuses
-- it for every role). Never grant DELETE or TRUNCATE: there is no DELETE
-- policy, TRUNCATE is not subject to row security, and every Offer Engine fact
-- is kept.
--
-- The auth lookup role must hold NO privilege on these tables
-- (AUTH_LOOKUP_FORBIDDEN_GRANTS); it has BYPASSRLS, so any grant would expose
-- every tenant's offers and promotion facts.

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
REVOKE UPDATE ON offers, offer_versions, offer_version_stores, offer_version_rules, offer_pauses FROM :"domain_role";
REVOKE UPDATE ON offer_pack_revisions, offer_pack_store_revisions, offer_pack_eligible_products, sale_line_promotions, sale_return_promotion_clawbacks FROM :"domain_role";
GRANT SELECT, INSERT ON offers, offer_versions, offer_version_stores, offer_version_rules, offer_pauses TO :"domain_role";
GRANT SELECT, INSERT ON offer_pack_revisions, offer_pack_store_revisions, offer_pack_eligible_products TO :"domain_role";
GRANT SELECT, INSERT ON sale_line_promotions, sale_return_promotion_clawbacks TO :"domain_role";
GRANT UPDATE (draft_revision, draft_definition, draft_updated_at, draft_updated_by_user_id, ended_at, ended_by_user_id, archived_at, archived_by_user_id) ON offers TO :"domain_role";
GRANT UPDATE (resumed_at, resumed_by_user_id) ON offer_pauses TO :"domain_role";
GRANT UPDATE (applied_revision) ON offer_pack_store_revisions TO :"domain_role";
GRANT UPDATE (to_revision) ON offer_pack_eligible_products TO :"domain_role";

-- Verify the domain role: every row must read `t`.
SELECT t.tbl, t.priv, has_table_privilege(:'domain_role', t.tbl, t.priv) AS granted
  FROM (VALUES ('offers', 'SELECT'),
               ('offers', 'INSERT'),
               ('offer_versions', 'SELECT'),
               ('offer_versions', 'INSERT'),
               ('offer_version_stores', 'SELECT'),
               ('offer_version_stores', 'INSERT'),
               ('offer_version_rules', 'SELECT'),
               ('offer_version_rules', 'INSERT'),
               ('offer_pauses', 'SELECT'),
               ('offer_pauses', 'INSERT'),
               ('offer_pack_revisions', 'SELECT'),
               ('offer_pack_revisions', 'INSERT'),
               ('offer_pack_store_revisions', 'SELECT'),
               ('offer_pack_store_revisions', 'INSERT'),
               ('offer_pack_eligible_products', 'SELECT'),
               ('offer_pack_eligible_products', 'INSERT'),
               ('sale_line_promotions', 'SELECT'),
               ('sale_line_promotions', 'INSERT'),
               ('sale_return_promotion_clawbacks', 'SELECT'),
               ('sale_return_promotion_clawbacks', 'INSERT')) AS t(tbl, priv);

SELECT c.tbl, c.col, has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE') AS granted
  FROM (VALUES ('offers', 'draft_revision'),
               ('offers', 'draft_definition'),
               ('offers', 'draft_updated_at'),
               ('offers', 'draft_updated_by_user_id'),
               ('offers', 'ended_at'),
               ('offers', 'ended_by_user_id'),
               ('offers', 'archived_at'),
               ('offers', 'archived_by_user_id'),
               ('offer_pauses', 'resumed_at'),
               ('offer_pauses', 'resumed_by_user_id'),
               ('offer_pack_store_revisions', 'applied_revision'),
               ('offer_pack_eligible_products', 'to_revision')) AS c(tbl, col);

-- No wider UPDATE: the immutable columns must read `f`.
SELECT c.tbl, c.col, has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE') AS granted
  FROM (VALUES ('offers', 'tenant_id'),
               ('offers', 'created_by_user_id'),
               ('offer_pauses', 'reason'),
               ('offer_pauses', 'store_id'),
               ('offer_pack_store_revisions', 'tenant_id'),
               ('offer_pack_store_revisions', 'store_id'),
               ('offer_pack_eligible_products', 'product_id'),
               ('offer_pack_eligible_products', 'offer_id'),
               ('offer_pack_eligible_products', 'from_revision'),
               ('offer_versions', 'percent_off'),
               ('offer_versions', 'name_ar'),
               ('offer_version_stores', 'store_id'),
               ('offer_version_rules', 'product_id'),
               ('offer_pack_revisions', 'revision'),
               ('sale_line_promotions', 'discount_amount'),
               ('sale_return_promotion_clawbacks', 'amount')) AS c(tbl, col);

SELECT (SELECT bool_and(has_table_privilege(:'domain_role', t.tbl, t.priv))
          FROM (VALUES ('offers', 'SELECT'),
                       ('offers', 'INSERT'),
                       ('offer_versions', 'SELECT'),
                       ('offer_versions', 'INSERT'),
                       ('offer_version_stores', 'SELECT'),
                       ('offer_version_stores', 'INSERT'),
                       ('offer_version_rules', 'SELECT'),
                       ('offer_version_rules', 'INSERT'),
                       ('offer_pauses', 'SELECT'),
                       ('offer_pauses', 'INSERT'),
                       ('offer_pack_revisions', 'SELECT'),
                       ('offer_pack_revisions', 'INSERT'),
                       ('offer_pack_store_revisions', 'SELECT'),
                       ('offer_pack_store_revisions', 'INSERT'),
                       ('offer_pack_eligible_products', 'SELECT'),
                       ('offer_pack_eligible_products', 'INSERT'),
                       ('sale_line_promotions', 'SELECT'),
                       ('sale_line_promotions', 'INSERT'),
                       ('sale_return_promotion_clawbacks', 'SELECT'),
                       ('sale_return_promotion_clawbacks', 'INSERT')) AS t(tbl, priv))
       AND (SELECT bool_and(has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE'))
              FROM (VALUES ('offers', 'draft_revision'),
                           ('offers', 'draft_definition'),
                           ('offers', 'draft_updated_at'),
                           ('offers', 'draft_updated_by_user_id'),
                           ('offers', 'ended_at'),
                           ('offers', 'ended_by_user_id'),
                           ('offers', 'archived_at'),
                           ('offers', 'archived_by_user_id'),
                           ('offer_pauses', 'resumed_at'),
                           ('offer_pauses', 'resumed_by_user_id'),
                           ('offer_pack_store_revisions', 'applied_revision'),
                           ('offer_pack_eligible_products', 'to_revision')) AS c(tbl, col))
       AND NOT (SELECT bool_or(has_column_privilege(:'domain_role', c.tbl, c.col, 'UPDATE'))
                  FROM (VALUES ('offers', 'tenant_id'),
                               ('offers', 'created_by_user_id'),
                               ('offer_pauses', 'reason'),
                               ('offer_pauses', 'store_id'),
                               ('offer_pack_store_revisions', 'tenant_id'),
                               ('offer_pack_store_revisions', 'store_id'),
                               ('offer_pack_eligible_products', 'product_id'),
                               ('offer_pack_eligible_products', 'offer_id'),
                               ('offer_pack_eligible_products', 'from_revision'),
                               ('offer_versions', 'percent_off'),
                               ('offer_versions', 'name_ar'),
                               ('offer_version_stores', 'store_id'),
                               ('offer_version_rules', 'product_id'),
                               ('offer_pack_revisions', 'revision'),
                               ('sale_line_promotions', 'discount_amount'),
                               ('sale_return_promotion_clawbacks', 'amount')) AS c(tbl, col))
       AS domain_ok \gset

\if :domain_ok
  COMMIT;
  \echo 'OK: domain role holds every required Offer Engine grant.'
\else
  ROLLBACK;
  \echo 'FAILED: the domain role is missing a required grant or holds a wider UPDATE (see the tables above). Nothing was changed.'
  DO $$ BEGIN RAISE EXCEPTION 'Offer Engine domain grants incomplete'; END $$;
\endif
