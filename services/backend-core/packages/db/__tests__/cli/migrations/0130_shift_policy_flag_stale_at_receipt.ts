/**
 * 0130_shift_policy_flag_stale_at_receipt (RT-592): `shifts_frozen_policy_flags_valid` widened to the fourth flag
 * `policy_revision_stale_at_receipt`. The constraint exists before and after the migration, so the probe reads its
 * definition: one constraint names the new flag when applied, none after the down.
 */
import type { MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0130_shift_policy_flag_stale_at_receipt",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
          WHERE conname = 'shifts_frozen_policy_flags_valid'
            AND conrelid = 'public.shifts'::regclass
            AND pg_get_constraintdef(oid) LIKE '%policy_revision_stale_at_receipt%'`,
      ),
    ],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
