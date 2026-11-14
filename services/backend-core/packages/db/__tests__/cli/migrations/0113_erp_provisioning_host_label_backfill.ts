/**
 * 0113_erp_provisioning_host_label_backfill (RT-1389 Phase 2): the data move runs inside
 * `erp_provisioning_backfill_host_labels()`, which stays for the post-deploy re-run; the
 * probe reads that function (the probe database holds no provisioning rows).
 */
import type { MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0113_erp_provisioning_host_label_backfill",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_proc WHERE proname = 'erp_provisioning_backfill_host_labels'`,
      ),
    ],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
