/** 0094_tracking_resolutions (RT-451 S5): [the tracking_resolutions and tracking_resolution_lines tables, their four policies (SELECT + INSERT each)]. */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["tracking_resolutions", "tracking_resolution_lines"];

export const MIGRATION: MigrationEntry = {
  id: "0094_tracking_resolutions",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["2", "4"],
    rolledBack: ["0", "0"],
  },
};
