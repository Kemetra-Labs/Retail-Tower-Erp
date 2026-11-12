/** 0099_sale_tender_voucher (RT-1114): [sale_tenders.redemption_id, its CHECK, FK and the voucher_redemptions key, the partial unique index, the method CHECK naming `voucher`]. */
import { countColumns, countConstraints, countIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0099_sale_tender_voucher",
  probe: {
    measure: async (db) => [
      await countColumns(db, "sale_tenders", ["redemption_id"]),
      await countConstraints(db, [
        "sale_tenders_redemption_voucher_only",
        "fk_sale_tenders_redemption_tenant_store",
        "voucher_redemptions_tenant_store_id_uk",
      ]),
      await countIndexes(db, ["uq_sale_tenders_tenant_redemption"]),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
         WHERE conname = 'sale_tenders_method_valid' AND pg_get_constraintdef(oid) LIKE '%voucher%'`,
      ),
    ],
    applied: ["1", "3", "1", "1"],
    rolledBack: ["0", "0", "0", "0"],
  },
};
