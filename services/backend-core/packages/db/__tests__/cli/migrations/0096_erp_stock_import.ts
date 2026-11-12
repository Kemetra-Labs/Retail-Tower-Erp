/** 0096_erp_stock_import (RT-1288): [the four ERP stock import tables, their ten policies]. */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = [
  "erp_stock_import_runs",
  "erp_stock_import_pages",
  "erp_stock_import_rows",
  "erp_stock_import_findings",
];

export const MIGRATION: MigrationEntry = {
  id: "0096_erp_stock_import",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["4", "10"],
    rolledBack: ["0", "0"],
  },
};
