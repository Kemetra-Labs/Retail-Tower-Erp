/** 0092_voucher_redemptions (RT-1111): [the voucher_redemption_intents and voucher_redemptions tables, their policies (3 + 3)]. */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["voucher_redemption_intents", "voucher_redemptions"];

export const MIGRATION: MigrationEntry = {
  id: "0092_voucher_redemptions",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["2", "6"],
    rolledBack: ["0", "0"],
  },
};
