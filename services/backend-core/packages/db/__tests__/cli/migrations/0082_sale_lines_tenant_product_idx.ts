/** 0082_sale_lines_tenant_product_idx (RT-459): [the one valid partial product-history index on sale_lines, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0082_sale_lines_tenant_product_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["idx_sale_lines_tenant_product"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
