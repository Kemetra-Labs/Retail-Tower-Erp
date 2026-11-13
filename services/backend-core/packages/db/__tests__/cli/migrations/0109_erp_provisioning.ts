/**
 * 0109_erp_provisioning (RT-1357): [`erp_provisioning_request`,
 * `erp_provisioning_step_log` and `erp_provisioner_credential` with their
 * policies, the `managed_by` column and the seeded system actor]. The down
 * refuses while provisioning data exists; the probe runs on an empty database.
 * 0108 is reserved for the RT-1350 slice 2 migration (pending signups).
 */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["erp_provisioning_request", "erp_provisioning_step_log", "erp_provisioner_credential"];

export const MIGRATION: MigrationEntry = {
  id: "0109_erp_provisioning",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM information_schema.columns
          WHERE table_name = 'connector_registration' AND column_name = 'managed_by'`,
      ),
      await db.count(`SELECT COUNT(*)::text AS count FROM users WHERE id = '00000000-0000-7000-8000-000000001357'`),
    ],
    applied: ["3", "13", "1", "1"],
    rolledBack: ["0", "0", "0", "0"],
  },
};
