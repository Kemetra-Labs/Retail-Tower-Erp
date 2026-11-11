-- 0097_tenant_product_brands.sql
--
-- Product Brand in the Tenant Catalog (Jira RT-1334, RT-286 spec 048 slice
-- S1). [GATED: migration]. 0093 is held by an open PR (RT-1312, #508), 0094
-- is taken (RT-451 S5), 0095 is reserved for RT-451 S6 and 0096 is held by an
-- open PR (RT-1288, #516), so this takes 0097.
--
-- Source-of-truth artifacts:
--   - services/backend-core/specs/048-offer-engine-v1/spec.md (Brand, F-6, S1)
--   - packages/contracts/openapi/catalog/console-catalog.yaml
--       (`consoleListCatalogBrands`, `consoleCreateCatalogBrand`,
--        `consoleRenameCatalogBrand`, `brandId` / `brandName` / `brand_id`)
--   - packages/db/__tests__/migration/0097-tenant-product-brands.spec.ts
--
-- 1. `tenant_product_brands` — a flat (non-hierarchical) brand taxonomy owned
--    by a tenant, shaped like `tenant_product_categories` (0007): a name of 1
--    to 200 characters, unique among the tenant's ACTIVE brands (partial
--    unique index on `retired_at IS NULL`, so a retired brand frees its
--    name), and `retired_at` as the active flag. No parent, no description,
--    no ERPNext mapping (OD-1; brand is a Retail Tower catalog dimension
--    only).
-- 2. `tenant_products.brand_id` — nullable: a product has at most one brand.
--    The FK is COMPOSITE, (tenant_id, brand_id) -> (tenant_id, id), so a
--    product can never point at another tenant's brand (the FK check itself
--    bypasses RLS), and `ON DELETE SET NULL (brand_id)` (PostgreSQL 15+)
--    clears only `brand_id` when a brand is deleted: the product stays, with
--    no brand. Retiring a brand (`retired_at`) leaves its products' brand_id
--    as is, as retiring a category does.
--
-- RLS: `tenant_product_brands` is ENABLE + FORCE with tenant policies for
-- SELECT, INSERT and UPDATE (the empty-GUC CASE guard of 0010 / 0091). There
-- is NO DELETE policy: no runtime deletes a brand (the Console API lists,
-- creates and renames). `tenant_products.brand_id` rides the existing
-- `tenant_products` tenant policies.
--
-- Grants: SELECT, INSERT and UPDATE for the domain role outside migrations:
-- docs/operations/sql/tenant-product-brands-domain-grants.sql (deploy/README.md
-- step 2). The API refuses to boot without them (DOMAIN_REQUIRED_GRANTS).
-- `tenant_products` is already read and written by the domain role.
--
-- POS: unchanged (OD-6, the till never needs a brand). `brand_id` is not a
-- sellable-relevant field of the 0015 `catalog_change_log` trigger, so setting
-- or clearing it writes no change-log row and the read-down does not move.
--
-- DATA-LIFECYCLE CLASSIFICATION (SI-012 / §XIV): BUSINESS-CLASS catalog master
-- data. A brand name, opaque UUIDs (`created_by` is an operational actor id)
-- and timestamps. No PII, no money, no secret.
--
-- Deploy window: none. The table is new and empty; the column is nullable with
-- no default, no existing writer names it, and the previous release keeps
-- working. Apply 0097 and the grants script before the API that uses them.
--
-- Lock impact:
--   - In the transaction: `tenant_products` takes ACCESS EXCLUSIVE for the
--     catalog-only ADD COLUMN (nullable, no default, no rewrite) and the
--     NOT VALID FK (no scan); the partial index on the new all-NULL column is
--     built under that lock (one heap scan, empty index). `tenants` takes SHARE
--     ROW EXCLUSIVE for the new table's FK. At pilot volume, well under a
--     second; lock_timeout 2s, so a lock that cannot be taken rolls the
--     migration back to be re-run.
--   - After COMMIT: VALIDATE CONSTRAINT under SHARE UPDATE EXCLUSIVE, which
--     does not block reads or writes (the 0077 pattern). Every existing
--     brand_id is NULL, so nothing can fail it.
--
-- Reversal: 0097_tenant_product_brands.down.sql REFUSES while any brand exists
-- (it would lose catalog master data and every product's brand); otherwise it
-- drops the column, then the table.

BEGIN;

SET LOCAL lock_timeout = '2s';

-- =============================================================================
-- 1. tenant_product_brands
-- =============================================================================

CREATE TABLE tenant_product_brands (
  id          UUID         PRIMARY KEY,
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name        TEXT         NOT NULL,
  retired_at  TIMESTAMPTZ  NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by  UUID         NOT NULL,
  CONSTRAINT tenant_product_brands_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  -- Composite FK target of tenant_products.brand_id (same-tenant reference).
  CONSTRAINT tenant_product_brands_tenant_id_uk UNIQUE (tenant_id, id)
);

-- The Console list: the tenant's active brands.
CREATE INDEX idx_tenant_product_brands_tenant_active
  ON tenant_product_brands (tenant_id) WHERE retired_at IS NULL;

-- One ACTIVE brand per (tenant, name); names compare exactly, as categories do.
CREATE UNIQUE INDEX "UQ_idx_tenant_product_brands_tenant_name"
  ON tenant_product_brands (tenant_id, name) WHERE retired_at IS NULL;

CREATE TRIGGER tenant_product_brands_set_updated_at BEFORE UPDATE ON tenant_product_brands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tenant_product_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_product_brands FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_product_brands_tenant_select ON tenant_product_brands
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY tenant_product_brands_tenant_insert ON tenant_product_brands
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

CREATE POLICY tenant_product_brands_tenant_update ON tenant_product_brands
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- =============================================================================
-- 2. tenant_products.brand_id
-- =============================================================================

ALTER TABLE tenant_products
  ADD COLUMN brand_id UUID;

-- NOT VALID: no scan under ACCESS EXCLUSIVE (every existing row is NULL);
-- validated after COMMIT below.
ALTER TABLE tenant_products
  ADD CONSTRAINT fk_tenant_products_brand_tenant
    FOREIGN KEY (tenant_id, brand_id) REFERENCES tenant_product_brands (tenant_id, id)
    ON DELETE SET NULL (brand_id)
    NOT VALID;

-- The brand filter, and the ON DELETE SET NULL lookup (an equality on brand_id
-- implies brand_id IS NOT NULL, so the partial index serves it).
CREATE INDEX idx_tenant_products_tenant_brand
  ON tenant_products (tenant_id, brand_id)
  WHERE brand_id IS NOT NULL;

COMMIT;

ALTER TABLE tenant_products
  VALIDATE CONSTRAINT fk_tenant_products_brand_tenant;
