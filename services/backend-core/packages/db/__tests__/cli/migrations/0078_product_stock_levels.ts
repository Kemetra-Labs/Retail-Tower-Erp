/**
 * 0078_product_stock_levels (RT-1066): [the stock-levels table, its SELECT +
 * INSERT + UPDATE policies, its two partial unique indexes and its read index].
 */
import { countIndexes, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["product_stock_levels"];

export const MIGRATION: MigrationEntry = {
  id: "0078_product_stock_levels",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countIndexes(db, [
        "uq_product_stock_levels_tenant_active",
        "uq_product_stock_levels_store_active",
        "idx_product_stock_levels_store_active",
      ]),
    ],
    applied: ["1", "3", "3"],
    rolledBack: ["0", "0", "0"],
  },
};
