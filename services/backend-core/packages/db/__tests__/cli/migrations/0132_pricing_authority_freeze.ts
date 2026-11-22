/**
 * 0132_pricing_authority_freeze (RT-1485, spec 044 PR-16a-1): the three pricing authority tables,
 * their policies (3 SELECT + 3 INSERT + 1 UPDATE tenant policies, plus 3 for
 * pricing_projection_writer), the four functions and the three triggers on legacy tables.
 */
import { countFunctions, countPolicies, countTables, countTriggers, type MigrationEntry } from "../migration-probes";

const TABLES = ["tenant_pricing_authority", "pricing_import_runs", "pricing_cutover_runs"];

const FUNCTIONS = [
  "pricing_authority_for_share",
  "pricing_authority_seed_tenant",
  "pricing_legacy_freeze",
  "pricing_reverse_project",
];

const TRIGGERS = [
  "tenants_pricing_authority_seed",
  "tenant_products_pricing_freeze",
  "store_product_overrides_pricing_freeze",
];

export const MIGRATION: MigrationEntry = {
  id: "0132_pricing_authority_freeze",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countFunctions(db, FUNCTIONS),
      await countTriggers(db, TRIGGERS),
    ],
    applied: ["3", "10", "4", "3"],
    rolledBack: ["0", "0", "0", "0"],
  },
};
