/**
 * 0107_credit_reversal_voucher_refund (RT-1343 item 2): [`voucher` in the
 * `sale_credit_reversal_tenders_method_valid` CHECK]. The constraint keeps its
 * name across up and down, so the probe reads its definition, not its count.
 */
import type { MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0107_credit_reversal_voucher_refund",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
          WHERE conname = 'sale_credit_reversal_tenders_method_valid'
            AND pg_get_constraintdef(oid) LIKE '%''voucher''%'`,
      ),
    ],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
