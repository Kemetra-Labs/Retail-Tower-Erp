/**
 * 0128_price_change_set_rollback_from_backfill (RT-1532): the data move runs inside
 * `price_change_set_backfill_rollback_from()`, which stays for the post-deploy re-run; the probe reads
 * that function (the probe database holds no rollback sets).
 */
import { countFunctions, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0128_price_change_set_rollback_from_backfill",
  probe: {
    measure: async (db) => [await countFunctions(db, ["price_change_set_backfill_rollback_from"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
