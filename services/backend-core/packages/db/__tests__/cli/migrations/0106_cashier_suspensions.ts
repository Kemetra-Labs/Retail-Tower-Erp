/**
 * 0106_cashier_suspensions (RT-1138): [the `cashier_suspensions` table and its
 * three policies (SELECT, INSERT, UPDATE; no DELETE)].
 */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["cashier_suspensions"];

export const MIGRATION: MigrationEntry = {
  id: "0106_cashier_suspensions",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["1", "3"],
    rolledBack: ["0", "0"],
  },
};
