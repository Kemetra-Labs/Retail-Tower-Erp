/** 0084_shift_closes_tenant_closed_idx (RT-429): [the one valid tenant-wide keyset index, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0084_shift_closes_tenant_closed_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["idx_shift_closes_tenant_closed"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
