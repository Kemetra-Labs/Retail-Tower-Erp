/** 0114_count_sessions (RT-1420): [the five Count Session tables, their 12 policies, the five settings columns]. */
import { countColumns, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = [
  "count_sessions",
  "count_session_lines",
  "count_session_expected",
  "count_observations",
  "count_late_event_findings",
];
const SETTINGS_COLUMNS = [
  "count_sessions_enabled",
  "count_self_approval_enabled",
  "count_self_approval_reason",
  "count_self_approval_changed_at",
  "count_self_approval_changed_by",
];

export const MIGRATION: MigrationEntry = {
  id: "0114_count_sessions",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countColumns(db, "tenant_inventory_settings", SETTINGS_COLUMNS),
    ],
    applied: ["5", "12", "5"],
    rolledBack: ["0", "0", "0"],
  },
};
