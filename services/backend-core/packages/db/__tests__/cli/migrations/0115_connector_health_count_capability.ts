/**
 * 0115_connector_health_count_capability (RT-1427): four nullable evidence columns on
 * `connector_health`. The probe counts those columns.
 */
import type { MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0115_connector_health_count_capability",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT COUNT(*)::text AS count FROM information_schema.columns
          WHERE table_name = 'connector_health'
            AND column_name IN ('accepted_work_item_kinds', 'back_dated_role_status',
                                'back_dated_role_checked_at', 'back_dated_role_reported_at')`,
      ),
    ],
    applied: ["4"],
    rolledBack: ["0"],
  },
};
