/**
 * 0134_sale_line_manual_discount (RT-1571): the seven manual-discount columns on `sale_lines`. The probe counts
 * them: all present when applied, none after the down.
 */
import { countColumns, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0134_sale_line_manual_discount",
  probe: {
    measure: async (db) => [
      await countColumns(db, "sale_lines", [
        "discount_kind",
        "discount_value",
        "discount_amount",
        "discount_reason_code",
        "discount_authority_source",
        "discount_approver_role",
        "discount_approver_user_id",
      ]),
    ],
    applied: ["7"],
    rolledBack: ["0"],
  },
};
