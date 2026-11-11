/** 0091_vouchers (RT-1107): [the vouchers and voucher_eligible_stores tables, their policies (3 + 2)]. */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["vouchers", "voucher_eligible_stores"];

export const MIGRATION: MigrationEntry = {
  id: "0091_vouchers",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["2", "5"],
    rolledBack: ["0", "0"],
  },
};
