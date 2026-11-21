/**
 * 0130_sync_failure_alerts (RT-1034): the two alert tables and their six policies
 * (SELECT, INSERT, UPDATE each; no DELETE).
 */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["sync_failure_alert_windows", "sync_failure_alert_deliveries"];

export const MIGRATION: MigrationEntry = {
  id: "0130_sync_failure_alerts",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["2", "6"],
    rolledBack: ["0", "0"],
  },
};
