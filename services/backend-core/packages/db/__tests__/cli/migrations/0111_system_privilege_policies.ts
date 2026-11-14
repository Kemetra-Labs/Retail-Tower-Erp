/**
 * 0111_system_privilege_policies (RT-1389 Phase 1): nine additive policies keyed on
 * `app.system_privilege` (signup, provisioning_sweep, provisioner_lookup) on tables owned by
 * 0105, 0108 and 0109. Those probes exclude these names (SYSTEM_PRIVILEGE_POLICIES), so each
 * migration's own policies stay countable when only this one is rolled back.
 */
import type { MigrationEntry } from "../migration-probes";

export const SYSTEM_PRIVILEGE_POLICIES: readonly string[] = [
  "pending_signups_signup_select",
  "pending_signups_signup_insert",
  "pending_signups_signup_update",
  "user_consents_signup_select",
  "user_consents_signup_insert",
  "tenant_access_entitlements_signup_insert",
  "erp_provisioning_request_sweep_select",
  "erp_provisioning_request_sweep_update",
  "erp_provisioner_credential_lookup_select",
];

export const MIGRATION: MigrationEntry = {
  id: "0111_system_privilege_policies",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_policies
          WHERE schemaname = 'public' AND policyname = ANY($1::text[])`,
        [SYSTEM_PRIVILEGE_POLICIES],
      ),
    ],
    applied: ["9"],
    rolledBack: ["0"],
  },
};
