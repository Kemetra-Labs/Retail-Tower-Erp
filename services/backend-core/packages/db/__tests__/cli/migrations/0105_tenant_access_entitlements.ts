/**
 * 0105_tenant_access_entitlements (RT-1353): [the `tenant_access_entitlements`
 * table, its three policies (SELECT, INSERT, UPDATE; no DELETE) and the forward-only
 * guard trigger]. 0104 is reserved for the RT-452 migration (PR #536).
 */
import { countTables, type MigrationEntry } from "../migration-probes";
import { SYSTEM_PRIVILEGE_POLICIES } from "./0111_system_privilege_policies";

const TABLES = ["tenant_access_entitlements"];

export const MIGRATION: MigrationEntry = {
  id: "0105_tenant_access_entitlements",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      // 0110 and 0111 add policies by name; each is counted by its own probe, so 0105's
      // three stay countable when only 0110 or 0111 is rolled back.
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY($1::text[])
            AND policyname <> 'tenant_access_entitlements_platform_select'
            AND NOT (policyname = ANY($2::text[]))`,
        [TABLES, SYSTEM_PRIVILEGE_POLICIES],
      ),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_trigger
          WHERE tgname = 'tenant_access_entitlements_guard' AND NOT tgisinternal`,
      ),
    ],
    applied: ["1", "3", "1"],
    rolledBack: ["0", "0", "0"],
  },
};
