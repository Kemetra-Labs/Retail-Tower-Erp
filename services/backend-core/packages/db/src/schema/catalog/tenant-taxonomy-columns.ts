/**
 * The columns a flat, tenant-owned catalog taxonomy shares (RT-1334):
 * `tenant_product_categories` (0007) and `tenant_product_brands` (0097) are the
 * same shape, apart from the category's `description`. A function, so each
 * table gets its own column builders. Not re-exported by the schema barrel.
 */
import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants } from "../tenants";

export function flatTaxonomyColumns() {
  return {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").notNull(),
  };
}
