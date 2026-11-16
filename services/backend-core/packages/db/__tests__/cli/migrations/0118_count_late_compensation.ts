/** 0118_count_late_compensation (RT-1424): [the compensation table, its 2 policies, the two import-row posting-stamp columns]. */
import { countColumns, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0118_count_late_compensation",
  probe: {
    measure: async (db) => [
      await countTables(db, ["count_late_compensations"]),
      await countPolicies(db, ["count_late_compensations"]),
      await countColumns(db, "erp_stock_import_rows", ["posting_date", "posting_time"]),
    ],
    applied: ["1", "2", "2"],
    rolledBack: ["0", "0", "0"],
  },
};
