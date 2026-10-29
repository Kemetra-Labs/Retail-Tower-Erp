/** 0075_erpnext_warehouse_map_ref_unique (RT-433): [the unique reverse index, the non-unique one it replaces]. */
import { countIndexes, countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0075_erpnext_warehouse_map_ref_unique",
  probe: {
    measure: async (db) => [
      await countValidIndexes(db, ["UQ_idx_erpnext_warehouse_map_ref_active"]),
      await countIndexes(db, ["idx_erpnext_warehouse_map_ref"]),
    ],
    applied: ["1", "0"],
    rolledBack: ["0", "1"],
  },
};
