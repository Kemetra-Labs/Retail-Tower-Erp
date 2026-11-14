/**
 * 0112_erp_provisioning_transitions_host_label (RT-1389 Phase 2): the `provisioned_host_label`
 * column (with its CHECK) and the `erp_provisioning_transition_allowed` function the guard
 * trigger now calls. The guard trigger itself is 0109's (its body is replaced, not added).
 */
import { countColumns, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0112_erp_provisioning_transitions_host_label",
  probe: {
    measure: async (db) => [
      await countColumns(db, "erp_provisioning_request", ["provisioned_host_label"]),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_proc WHERE proname = 'erp_provisioning_transition_allowed'`,
      ),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
          WHERE conname = 'erp_provisioning_request_provisioned_host_label_valid'`,
      ),
    ],
    applied: ["1", "1", "1"],
    rolledBack: ["0", "0", "0"],
  },
};
