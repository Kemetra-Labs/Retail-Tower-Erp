/**
 * 0124_catalog_import (RT-1503, spec 049 S2): the three manual-import tables,
 * their policies (3 SELECT + 3 INSERT + 3 UPDATE + 1 DELETE on the rows) and
 * their four functions.
 */
import { countFunctions, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["catalog_import_mapping_profiles", "catalog_import_batches", "catalog_import_rows"];

const FUNCTIONS = [
  "catalog_import_mapping_profiles_guard",
  "catalog_import_batches_guard",
  "catalog_import_batches_no_delete",
  "catalog_import_rows_guard",
];

export const MIGRATION: MigrationEntry = {
  id: "0124_catalog_import",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countFunctions(db, FUNCTIONS),
    ],
    applied: ["3", "10", "4"],
    rolledBack: ["0", "0", "0"],
  },
};
