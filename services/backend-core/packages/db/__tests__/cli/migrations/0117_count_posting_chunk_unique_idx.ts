/** 0117_count_posting_chunk_unique_idx (RT-1423): [the one valid partial unique index of erpnext_posting_status on (tenant_id, count_session_id, count_chunk), built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0117_count_posting_chunk_unique_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["UQ_idx_erpnext_posting_status_count_chunk"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
