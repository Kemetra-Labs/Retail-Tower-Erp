/** 0126_transfer_leg_unique_idx (RT-1513): [the one valid partial unique index of erpnext_posting_status on (tenant_id, external_id) over the two transfer kinds, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0126_transfer_leg_unique_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["UQ_idx_erpnext_posting_status_transfer_leg"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
