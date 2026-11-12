/** 0093_sale_quarantine_items (RT-1312 Phase 3(b)): [the sale_quarantine_items table, its policies (3)]. */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["sale_quarantine_items"];

export const MIGRATION: MigrationEntry = {
  id: "0093_sale_quarantine_items",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["1", "3"],
    rolledBack: ["0", "0"],
  },
};
