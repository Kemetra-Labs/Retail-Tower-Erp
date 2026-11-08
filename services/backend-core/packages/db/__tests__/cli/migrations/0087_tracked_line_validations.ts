/** 0087_tracked_line_validations (RT-451 S2): [the tracked_line_validations table, its two policies (SELECT + INSERT)]. */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["tracked_line_validations"];

export const MIGRATION: MigrationEntry = {
  id: "0087_tracked_line_validations",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["1", "2"],
    rolledBack: ["0", "0"],
  },
};
