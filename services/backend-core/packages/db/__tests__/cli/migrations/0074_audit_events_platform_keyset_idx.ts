/** 0074_audit_events_platform_keyset_idx (RT-808): [the one valid partial keyset index, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0074_audit_events_platform_keyset_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["audit_events_platform_time_idx"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
