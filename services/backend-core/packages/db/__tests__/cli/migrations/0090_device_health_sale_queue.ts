/** 0090_device_health_sale_queue (RT-1312): [its four nullable device_health columns, their two CHECKs]. */
import { countColumns, countConstraints, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0090_device_health_sale_queue",
  probe: {
    measure: async (db) => [
      await countColumns(db, "device_health", [
        "sale_queue_pending",
        "sale_queue_dead_letter",
        "sale_queue_held",
        "sale_queue_oldest_pending_at",
      ]),
      await countConstraints(db, ["device_health_sale_queue_bounds", "device_health_sale_queue_consistent"]),
    ],
    applied: ["4", "2"],
    rolledBack: ["0", "0"],
  },
};
