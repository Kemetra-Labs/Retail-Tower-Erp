/**
 * 0079_pairing_codes_printer_ids_nullable (RT-1181 / RT-1165 S1): [the two printer
 * ID columns of pairing_codes that accept NULL, and the two hex CHECKs that stay].
 */
import { type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0079_pairing_codes_printer_ids_nullable",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT COUNT(*)::text AS count FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'pairing_codes'
           AND column_name = ANY($1::text[]) AND is_nullable = 'YES'`,
        [["printer_vendor_id", "printer_product_id"]],
      ),
      await db.count(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
         WHERE conname = ANY($1::text[]) AND convalidated`,
        [["pairing_codes_printer_vendor_id_hex", "pairing_codes_printer_product_id_hex"]],
      ),
    ],
    applied: ["2", "2"],
    rolledBack: ["0", "2"],
  },
};
