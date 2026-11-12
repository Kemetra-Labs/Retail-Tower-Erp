/**
 * `tenant_product_brands` — Flat (non-hierarchical) brand taxonomy owned by a
 * tenant (RT-1334, RT-286 spec 048 slice S1), shaped like
 * `tenant_product_categories`.
 *
 * No parent, no description, no ERPNext mapping: a brand is a Retail Tower
 * catalog dimension that offers target (spec 048 OD-1). A product has at most
 * one brand (`tenant_products.brand_id`).
 *
 * Partial unique index on `(tenant_id, name) WHERE retired_at IS NULL`
 * enforces uniqueness of active brand names within a tenant; `retired_at` is
 * the active flag. `(tenant_id, id)` is unique: the composite FK target of
 * `tenant_products.brand_id`.
 *
 * RLS: ENABLE + FORCE by `tenant_id`, SELECT / INSERT / UPDATE policies and no
 * DELETE policy. Policies live in `0097_tenant_product_brands.sql`.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { flatTaxonomyColumns } from "./tenant-taxonomy-columns";

export const tenantProductBrands = pgTable(
  "tenant_product_brands",
  // The category-shaped columns: id, tenant, name, retired_at and timestamps.
  flatTaxonomyColumns(),
  (t) => [
    check(
      "tenant_product_brands_name_length",
      sql`char_length(${t.name}) BETWEEN 1 AND 200`,
    ),
    unique("tenant_product_brands_tenant_id_uk").on(t.tenantId, t.id),
    index("idx_tenant_product_brands_tenant_active")
      .on(t.tenantId)
      .where(sql`${t.retiredAt} IS NULL`),
    uniqueIndex("UQ_idx_tenant_product_brands_tenant_name")
      .on(t.tenantId, t.name)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

export type TenantProductBrandRow = typeof tenantProductBrands.$inferSelect;
export type NewTenantProductBrandRow = typeof tenantProductBrands.$inferInsert;
