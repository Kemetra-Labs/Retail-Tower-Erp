/** 0127_price_change_set_rollback_from (RT-1532): [the two `change_sets` columns `rollback_from` / `rollback_from_defaulted`, their two CHECK constraints]. */
import { countColumns, countConstraints, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0127_price_change_set_rollback_from",
  probe: {
    measure: async (db) => [
      await countColumns(db, "change_sets", ["rollback_from", "rollback_from_defaulted"]),
      await countConstraints(db, ["change_sets_rollback_from_kind", "change_sets_rollback_from_whole"]),
    ],
    applied: ["2", "2"],
    rolledBack: ["0", "0"],
  },
};
