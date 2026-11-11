/**
 * 0095_tenant_product_brands (RT-1334, RT-286 S1): [the tenant_product_brands
 * table, its policies (3), the tenant_products.brand_id column, its validated
 * composite FK].
 */
import { countColumns, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["tenant_product_brands"];

export const MIGRATION: MigrationEntry = {
  id: "0095_tenant_product_brands",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countColumns(db, "tenant_products", ["brand_id"]),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
         WHERE conname = ANY($1::text[]) AND convalidated`,
        [["fk_tenant_products_brand_tenant"]],
      ),
    ],
    applied: ["1", "3", "1", "1"],
    rolledBack: ["0", "0", "0", "0"],
  },
};
