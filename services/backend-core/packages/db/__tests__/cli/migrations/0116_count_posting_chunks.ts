/** 0116_count_posting_chunks (RT-1423): [the count_posting_lines table, its 3 policies, the 4 chunk columns on erpnext_posting_status, the 2 switch-change columns]. */
import { countColumns, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const CHUNK_COLUMNS = ["count_session_id", "count_chunk", "count_chunk_total", "count_posting_datetime"];

export const MIGRATION: MigrationEntry = {
  id: "0116_count_posting_chunks",
  probe: {
    measure: async (db) => [
      await countTables(db, ["count_posting_lines"]),
      await countPolicies(db, ["count_posting_lines"]),
      await countColumns(db, "erpnext_posting_status", CHUNK_COLUMNS),
      await countColumns(db, "tenant_inventory_settings", ["count_sessions_changed_at", "count_sessions_changed_by"]),
    ],
    applied: ["1", "3", "4", "2"],
    rolledBack: ["0", "0", "0", "0"],
  },
};
