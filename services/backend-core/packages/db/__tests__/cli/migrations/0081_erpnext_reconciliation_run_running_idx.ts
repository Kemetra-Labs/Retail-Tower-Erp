/** 0081_erpnext_reconciliation_run_running_idx (RT-185): [the one valid partial running-run index, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0081_erpnext_reconciliation_run_running_idx",
  probe: {
    measure: async (db) => [
      await countValidIndexes(db, ["idx_erpnext_reconciliation_run_tenant_store_running"]),
    ],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
