/**
 * 0133_sale_seller_receiver_facts (RT-1565): the seller snapshot on `sale_lines`, the payment receiver on
 * `sale_tenders` and `memberships.seller_code`. The probe counts the five new columns: all present when
 * applied, none after the down.
 */
import type { MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0133_sale_seller_receiver_facts",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT COUNT(*)::text AS count FROM information_schema.columns
          WHERE table_schema = 'public'
            AND ((table_name = 'sale_lines' AND column_name IN ('seller_user_id', 'seller_store_id', 'seller_role_id'))
              OR (table_name = 'sale_tenders' AND column_name = 'received_by_user_id')
              OR (table_name = 'memberships' AND column_name = 'seller_code'))`,
      ),
    ],
    applied: ["5"],
    rolledBack: ["0"],
  },
};
