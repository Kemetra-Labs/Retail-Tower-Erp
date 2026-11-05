/**
 * 0080_pairing_codes_drop_printer_fields (RT-1184 / RT-1165 S4): [the three printer
 * columns of pairing_codes, and the three CHECKs that go with them].
 */
import { countColumns, countConstraints, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0080_pairing_codes_drop_printer_fields",
  probe: {
    measure: async (db) => [
      await countColumns(db, "pairing_codes", ["printer_vendor_id", "printer_product_id", "printer_com_port"]),
      await countConstraints(db, [
        "pairing_codes_printer_vendor_id_hex",
        "pairing_codes_printer_product_id_hex",
        "pairing_codes_printer_com_port_non_empty",
      ]),
    ],
    applied: ["0", "0"],
    rolledBack: ["3", "3"],
  },
};
