/**
 * `tenant_product_categories` — Flat (non-hierarchical) category taxonomy
 * owned by a tenant. (data-model.md §4)
 *
 * Q7: NO `parent_id` column. Hierarchical trees deferred from v1.
 *
 * Partial unique index on `(tenant_id, name) WHERE retired_at IS NULL`
 * enforces uniqueness of active category names within a tenant.
 *
 * RLS-enabled by `tenant_id`. Policy lives in `0001_catalog.sql`.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { flatTaxonomyColumns } from "./tenant-taxonomy-columns";

export const tenantProductCategories = pgTable(
  "tenant_product_categories",
  // The shared flat-taxonomy columns (RT-1334), plus the category description.
  { ...flatTaxonomyColumns(), description: text("description") },
  (t) => [
    check(
      "tenant_product_categories_name_length",
      sql`length(${t.name}) BETWEEN 1 AND 200`,
    ),
    index("idx_tenant_product_categories_tenant_active")
      .on(t.tenantId)
      .where(sql`${t.retiredAt} IS NULL`),
    uniqueIndex("UQ_idx_tenant_product_categories_tenant_name")
      .on(t.tenantId, t.name)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

export type TenantProductCategoryRow =
  typeof tenantProductCategories.$inferSelect;
export type NewTenantProductCategoryRow =
  typeof tenantProductCategories.$inferInsert;
