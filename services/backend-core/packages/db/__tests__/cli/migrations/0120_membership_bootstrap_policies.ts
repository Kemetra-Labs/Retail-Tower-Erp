/**
 * 0120_membership_bootstrap_policies (RT-1457 / A-04): five additive SELECT policies keyed on
 * `app.system_privilege = 'membership_bootstrap'` on memberships, roles, tenants, stores and
 * store_access. The probe counts them by name.
 */
import type { MigrationEntry } from "../migration-probes";

export const MEMBERSHIP_BOOTSTRAP_POLICIES: readonly string[] = [
  "memberships_membership_bootstrap_select",
  "roles_membership_bootstrap_select",
  "tenants_membership_bootstrap_select",
  "stores_membership_bootstrap_select",
  "store_access_membership_bootstrap_select",
];

export const MIGRATION: MigrationEntry = {
  id: "0120_membership_bootstrap_policies",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_policies
          WHERE schemaname = 'public' AND policyname = ANY($1::text[])`,
        [MEMBERSHIP_BOOTSTRAP_POLICIES],
      ),
    ],
    applied: ["5"],
    rolledBack: ["0"],
  },
};
