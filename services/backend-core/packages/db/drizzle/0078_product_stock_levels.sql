-- 0078_product_stock_levels.sql
--
-- A product's low-stock thresholds: the tenant default level and the per-store
-- deviation (Jira RT-1066; decision record
-- `docs/planning/rt-1064-low-stock-thresholds.md`, TH-1 to TH-5; contract
-- `catalog/stock-levels.yaml`). [GATED] migration, approved under the owner
-- delegation of 2026-11-02 (captain session) for RT-1066, exactly in the TH-5
-- shape. Applying it to the lab, a live database or any deploy is NOT
-- authorized by that decision.
--
-- Why a table of its own (TH-1 C): a threshold is a fourth concern next to
-- the price, availability and tax category of `store_product_overrides`,
-- which pricing OD-5 is splitting by concern. No column is added to
-- `tenant_products` or `store_product_overrides`, so the OD-5 split, the 044
-- MC-5 freeze trigger and the PR-16c removal precondition are unchanged, and
-- no `catalog_change_log` row (POS read-down) is ever produced: the POS never
-- uses a threshold.
--
-- Shape (TH-5 A, no backfill: no threshold exists on `main`, and ERPNext Item
-- reorder settings are deliberately not imported):
--   - one row per (tenant, product, scope): `store_id IS NULL` is the tenant
--     default level, `store_id IS NOT NULL` a store's level;
--   - at most one ACTIVE level per scope (partial unique indexes);
--   - a retire is an UPDATE setting `retired_at` (the row is kept); a level
--     set again after a retire is a new row;
--   - `0 < critical_level <= reorder_level` (TH-2; equal allowed), backing
--     the service's 422 `critical_above_reorder`;
--   - the product and the store are pinned to the row's own tenant by
--     composite FKs: `(product_id, tenant_id) → tenant_products (id,
--     tenant_id)` (target `uq_tenant_products_id_tenant`, 0045) and
--     `(tenant_id, store_id) → stores (tenant_id, id)` (target
--     `stores_tenant_id_uk`, 0000). MATCH SIMPLE: the store FK is not checked
--     for a tenant level (`store_id` NULL), which is the intent.
--
-- RLS: ENABLED and FORCED; SELECT, INSERT and UPDATE tenant policies on
-- `app.current_tenant` with the 0010 fail-closed CASE guard ('' → NULL).
-- No DELETE policy: a level is retired, never deleted. The store scope is
-- applied by the service with an explicit store predicate (the console
-- catalog rule, TH-5), not by a store-axis policy.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS class. Identifiers
-- (tenant, product, store), two exact-decimal quantities, timestamps, the
-- acting principals (`created_by` / `updated_by`, operational actor UUIDs,
-- never exposed on the wire) and the request correlation id. No PII, no
-- free text, no money and no tender data. Retained with the product; never
-- deleted by the runtime (retired rows are kept as history).
--
-- Lock impact: ONE transaction; every lock is held until COMMIT.
--   - tenants, stores, tenant_products: SHARE ROW EXCLUSIVE for the new FKs;
--     writes on them wait until COMMIT, reads continue.
--   - product_stock_levels is new; nothing reads it before COMMIT.
-- lock_timeout = 2s, per lock request (the 0047 rule): if a lock cannot be
-- taken in time the migration fails and rolls back; `migrate up` exits
-- non-zero with nothing applied; re-run it. Expected to take well under a
-- second once it has its locks (no backfill, no index build over data).
-- Grants: none here. The domain role's SELECT + INSERT + UPDATE on
-- product_stock_levels is granted by
-- docs/operations/sql/product-stock-levels-domain-grants.sql, run after this
-- migration and before the API starts (deploy/README.md step 2);
-- DOMAIN_REQUIRED_GRANTS refuses to boot without it.
-- Reversible via 0078_product_stock_levels.down.sql (refused while any level,
-- active or retired, is stored).

BEGIN;

SET LOCAL lock_timeout = '2s';

CREATE TABLE product_stock_levels (
  id              UUID           PRIMARY KEY,
  tenant_id       UUID           NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_id      UUID           NOT NULL,
  -- NULL = the tenant default level; else the store's level.
  store_id        UUID           NULL,
  reorder_level   NUMERIC(19,4)  NOT NULL,
  critical_level  NUMERIC(19,4)  NULL,
  retired_at      TIMESTAMPTZ    NULL,
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  created_by      UUID           NOT NULL,
  updated_by      UUID           NOT NULL,
  correlation_id  UUID           NULL,
  -- The product of the row's own tenant.
  CONSTRAINT fk_product_stock_levels_product
    FOREIGN KEY (product_id, tenant_id)
    REFERENCES tenant_products (id, tenant_id)
    ON DELETE RESTRICT,
  -- The store of the row's own tenant (not checked for a tenant level).
  CONSTRAINT fk_product_stock_levels_store
    FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT product_stock_levels_reorder_positive
    CHECK (reorder_level > 0),
  CONSTRAINT product_stock_levels_critical_range
    CHECK (critical_level IS NULL OR (critical_level > 0 AND critical_level <= reorder_level))
);

-- At most one active tenant level per product.
CREATE UNIQUE INDEX uq_product_stock_levels_tenant_active
  ON product_stock_levels (tenant_id, product_id)
  WHERE store_id IS NULL AND retired_at IS NULL;

-- At most one active level per (store, product).
CREATE UNIQUE INDEX uq_product_stock_levels_store_active
  ON product_stock_levels (tenant_id, store_id, product_id)
  WHERE store_id IS NOT NULL AND retired_at IS NULL;

-- The low-stock read: the active levels of a tenant, by store.
CREATE INDEX idx_product_stock_levels_store_active
  ON product_stock_levels (tenant_id, store_id)
  WHERE retired_at IS NULL;

CREATE TRIGGER product_stock_levels_set_updated_at BEFORE UPDATE ON product_stock_levels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE product_stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_stock_levels FORCE ROW LEVEL SECURITY;

CREATE POLICY product_stock_levels_tenant_select ON product_stock_levels
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY product_stock_levels_tenant_insert ON product_stock_levels
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY product_stock_levels_tenant_update ON product_stock_levels
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
