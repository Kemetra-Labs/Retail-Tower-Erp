/** 0119_shift_forced_close_console_origin (RT-1445): [the `closed_via` column, its 2 CHECKs]. */
import { countColumns, countConstraints, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0119_shift_forced_close_console_origin",
  probe: {
    measure: async (db) => [
      await countColumns(db, "shift_forced_closes", ["closed_via"]),
      await countConstraints(db, ["shift_forced_closes_closed_via_values", "shift_forced_closes_closed_via_device"]),
    ],
    applied: ["1", "2"],
    rolledBack: ["0", "0"],
  },
};
