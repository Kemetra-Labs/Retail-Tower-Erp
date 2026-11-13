/**
 * 0110_tenant_access_entitlements_platform_select (RT-1350 slice 6a): one additive
 * SELECT policy on `tenant_access_entitlements` (0105). The probe counts that policy
 * by name; 0105's own probe excludes it by name, so each survives the other's down.
 */
import type { MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0110_tenant_access_entitlements_platform_select",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'tenant_access_entitlements'
            AND policyname = 'tenant_access_entitlements_platform_select'`,
      ),
    ],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
