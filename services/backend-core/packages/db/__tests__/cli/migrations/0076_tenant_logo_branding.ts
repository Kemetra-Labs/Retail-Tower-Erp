/** 0076_tenant_logo_branding (RT-473 S2): [its three tables, their 11 policies, the revision trigger]. */
import { countPolicies, countTables, countTriggers, type MigrationEntry } from "../migration-probes";

const TABLES = ["tenant_branding_revisions", "tenant_logos", "tenant_logo_renditions"];

export const MIGRATION: MigrationEntry = {
  id: "0076_tenant_logo_branding",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countTriggers(db, ["tenant_branding_revisions_monotonic"]),
    ],
    applied: ["3", "11", "1"],
    rolledBack: ["0", "0", "0"],
  },
};
