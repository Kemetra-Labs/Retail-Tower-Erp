/**
 * 0079_pairing_codes_printer_ids_nullable (RT-1181 / RT-1165 S1): [the two printer
 * ID columns of pairing_codes that accept NULL].
 *
 * RT-1184 (S4, migration 0080) later DROPS those columns, and its own down brings
 * them back nullable. So this probe must read the same with 0080 applied or rolled
 * back: it counts the two ids that do NOT carry a NOT NULL, and a column that is
 * absent counts as not carrying one. The hex CHECKs that 0079 leaves in place are
 * proved by `migration/0079-pairing-codes-printer-ids-nullable.spec.ts`, not here,
 * because 0080 drops and re-adds them.
 */
import { type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0079_pairing_codes_printer_ids_nullable",
  probe: {
    measure: async (db) => [
      await db.count(
        `SELECT (2 - COUNT(*))::text AS count FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'pairing_codes'
           AND column_name = ANY($1::text[]) AND is_nullable = 'NO'`,
        [["printer_vendor_id", "printer_product_id"]],
      ),
    ],
    applied: ["2"],
    rolledBack: ["0"],
  },
};
