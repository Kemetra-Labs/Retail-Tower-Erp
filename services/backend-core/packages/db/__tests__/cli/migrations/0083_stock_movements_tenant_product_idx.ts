/** 0083_stock_movements_tenant_product_idx (RT-459): [the one valid partial product-history index on stock_movements, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0083_stock_movements_tenant_product_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["idx_stock_movements_tenant_product"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
