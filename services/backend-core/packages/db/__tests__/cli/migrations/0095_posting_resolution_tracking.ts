/**
 * 0095_posting_resolution_tracking (RT-451 S6): [the four tracking columns of
 * erpnext_posting_resolution, their four validated CHECKs].
 */
import { countColumns, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0095_posting_resolution_tracking",
  probe: {
    measure: async (db) => [
      await countColumns(db, "erpnext_posting_resolution", [
        "tracking_mode",
        "tracking_identity_id",
        "erpnext_batch_ref",
        "erp_hold_cause",
      ]),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
         WHERE conname = ANY($1::text[]) AND convalidated`,
        [[
          "erpnext_posting_resolution_tracking_mode_valid",
          "erpnext_posting_resolution_batch_ref_length",
          "erpnext_posting_resolution_hold_cause_valid",
          "erpnext_posting_resolution_tracking_consistent",
        ]],
      ),
    ],
    applied: ["4", "4"],
    rolledBack: ["0", "0"],
  },
};
