/**
 * 0122_sale_line_pricing_provenance (RT-1151, RT-282 PR-07): the sale-line pricing provenance
 * table, its policies (SELECT + INSERT) and its append-only function.
 */
import { countFunctions, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["sale_line_pricing_provenance"];

export const MIGRATION: MigrationEntry = {
  id: "0122_sale_line_pricing_provenance",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countFunctions(db, ["sale_line_pricing_provenance_append_only"]),
    ],
    applied: ["1", "2", "1"],
    rolledBack: ["0", "0", "0"],
  },
};
