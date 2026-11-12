/**
 * 0103_tracking_identity_birth (RT-453): [the four birth / resolution / identity
 * anchor tables, their eight policies, and `tracking_mismatch` in the validated
 * reconciliation class CHECK].
 */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = [
  "tracking_identity_births",
  "erp_stock_import_row_resolutions",
  "inventory_identity_anchors",
  "inventory_identity_anchor_lines",
];

export const MIGRATION: MigrationEntry = {
  id: "0103_tracking_identity_birth",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
          WHERE conname = 'erpnext_reconciliation_result_class_valid'
            AND pg_get_constraintdef(oid) LIKE '%tracking_mismatch%'`,
      ),
    ],
    applied: ["4", "8", "1"],
    rolledBack: ["0", "0", "0"],
  },
};
