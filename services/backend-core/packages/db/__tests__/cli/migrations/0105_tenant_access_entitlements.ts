/**
 * 0105_tenant_access_entitlements (RT-1353): [the `tenant_access_entitlements`
 * table, its three policies (SELECT, INSERT, UPDATE; no DELETE) and the forward-only
 * guard trigger]. 0104 is reserved for the RT-452 migration (PR #536).
 */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["tenant_access_entitlements"];

export const MIGRATION: MigrationEntry = {
  id: "0105_tenant_access_entitlements",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_trigger
          WHERE tgname = 'tenant_access_entitlements_guard' AND NOT tgisinternal`,
      ),
    ],
    applied: ["1", "3", "1"],
    rolledBack: ["0", "0", "0"],
  },
};
