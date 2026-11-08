/** 0089_sale_capture_tracking (RT-451 S3): [sale_lines' seven tracking columns, sales' three columns, the sale_line_findings table, its two policies, the eleven CHECKs]. */
import { countColumns, countConstraints, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["sale_line_findings"];

export const MIGRATION: MigrationEntry = {
  id: "0089_sale_capture_tracking",
  probe: {
    measure: async (db) => [
      await countColumns(db, "sale_lines", [
        "tracking_identity_id",
        "tracking_code",
        "tracking_expiry_date",
        "tracking_selection",
        "tracking_validation_id",
        "tracking_class",
        "tracking_unresolved_reason",
      ]),
      await countColumns(db, "sales", ["safety_revision", "safety_synced_at", "tracking_status"]),
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countConstraints(db, [
        "sale_lines_tracking_snapshot_whole",
        "sale_lines_tracking_code_shape",
        "sale_lines_tracking_expiry_in_range",
        "sale_lines_tracking_selection_allowed",
        "sale_lines_tracking_class_allowed",
        "sale_lines_tracking_unresolved_reason_allowed",
        "sale_lines_tracking_unresolved_reason_iff",
        "sale_lines_tracking_snapshot_classified",
        "sale_lines_tracking_missing_has_no_snapshot",
        "sales_safety_revision_non_negative",
        "sales_tracking_status_allowed",
      ]),
    ],
    applied: ["7", "3", "1", "2", "11"],
    rolledBack: ["0", "0", "0", "0", "0"],
  },
};
