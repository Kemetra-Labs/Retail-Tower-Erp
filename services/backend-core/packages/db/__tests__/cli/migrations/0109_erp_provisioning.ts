/**
 * 0109_erp_provisioning (RT-1357): [`erp_provisioning_request`,
 * `erp_provisioning_step_log` and `erp_provisioner_credential` with their
 * policies, the `managed_by` column and the seeded system actor]. The down
 * refuses while provisioning data exists; the probe runs on an empty database.
 * 0108 is reserved for the RT-1350 slice 2 migration (pending signups).
 */
import { countTables, type MigrationEntry } from "../migration-probes";
import { SYSTEM_PRIVILEGE_POLICIES } from "./0111_system_privilege_policies";

const TABLES = ["erp_provisioning_request", "erp_provisioning_step_log", "erp_provisioner_credential"];

export const MIGRATION: MigrationEntry = {
  id: "0109_erp_provisioning",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      // 0111 adds its own policies here by name; they are counted by 0111's own probe.
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY($1::text[]) AND NOT (policyname = ANY($2::text[]))`,
        [TABLES, SYSTEM_PRIVILEGE_POLICIES],
      ),
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
