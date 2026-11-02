/**
 * 0077_sale_sync_status_version (RT-1061 / RT-973): [the sync_status_version
 * column, its validated range CHECK].
 */
import { countColumns, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0077_sale_sync_status_version",
  probe: {
    measure: async (db) => [
      await countColumns(db, "sales", ["sync_status_version"]),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
         WHERE conname = ANY($1::text[]) AND convalidated`,
        [["sales_sync_status_version_range"]],
      ),
    ],
    applied: ["1", "1"],
    rolledBack: ["0", "0"],
  },
};
