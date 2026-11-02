/**
 * `product_stock_levels` — a product's low-stock thresholds (0078, Jira
 * RT-1066; decision record `docs/planning/rt-1064-low-stock-thresholds.md`,
 * TH-1 to TH-5; contract `catalog/stock-levels.yaml`).
 *
 * One row per (tenant, product, scope): `store_id` NULL is the tenant default
 * level, a store id is that store's level. At most one ACTIVE level per scope
 * (two partial unique indexes); a retire sets `retired_at` and keeps the row.
 * `0 < critical_level <= reorder_level` (TH-2), in the product's stocking
 * unit at the store; never derived from or synced with ERPNext.
 *
 * The product and the store are pinned to the row's tenant by composite FKs
 * (`(product_id, tenant_id) → tenant_products (id, tenant_id)`,
 * `(tenant_id, store_id) → stores (tenant_id, id)`), defined in 0078's SQL.
 *
 * RLS: ENABLE + FORCE, SELECT + INSERT + UPDATE tenant policies, no DELETE.
 * §XIV: BUSINESS class — opaque ids, two quantities, timestamps, the acting
 * principals. No PII, no money.
 */
import { sql } from "drizzle-orm";
import { check, index, numeric, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { tenants } from "../tenants";

export const productStockLevels = pgTable(
  "product_stock_levels",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    productId: uuid("product_id").notNull(),
    storeId: uuid("store_id"),
    reorderLevel: numeric("reorder_level", { precision: 19, scale: 4 }).notNull(),
    criticalLevel: numeric("critical_level", { precision: 19, scale: 4 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    correlationId: uuid("correlation_id"),
  },
  (t) => [
    check("product_stock_levels_reorder_positive", sql`${t.reorderLevel} > 0`),
    check(
      "product_stock_levels_critical_range",
      sql`${t.criticalLevel} IS NULL OR (${t.criticalLevel} > 0 AND ${t.criticalLevel} <= ${t.reorderLevel})`,
    ),
    uniqueIndex("uq_product_stock_levels_tenant_active")
      .on(t.tenantId, t.productId)
      .where(sql`${t.storeId} IS NULL AND ${t.retiredAt} IS NULL`),
    uniqueIndex("uq_product_stock_levels_store_active")
      .on(t.tenantId, t.storeId, t.productId)
      .where(sql`${t.storeId} IS NOT NULL AND ${t.retiredAt} IS NULL`),
    index("idx_product_stock_levels_store_active")
      .on(t.tenantId, t.storeId)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

export type ProductStockLevelRow = typeof productStockLevels.$inferSelect;
export type NewProductStockLevelRow = typeof productStockLevels.$inferInsert;
