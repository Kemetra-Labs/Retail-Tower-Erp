/**
 * 0125_shipment_transfers (RT-1513, RT-291 Gate 5): the eight shipment Transfer tables (the shared reservations, the
 * Transfer document with its lines, receipts, receipt lines and discrepancies, and the frozen transfer leg bodies), their 24
 * policies (3 each: SELECT, INSERT, UPDATE) and `store_business_date()`.
 */
import { countFunctions, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = [
  "inventory_reservations",
  "shipment_transfers",
  "shipment_transfer_lines",
  "shipment_transfer_receipts",
  "shipment_transfer_receipt_lines",
  "shipment_transfer_discrepancies",
  "transfer_postings",
  "transfer_posting_lines",
];

export const MIGRATION: MigrationEntry = {
  id: "0125_shipment_transfers",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countFunctions(db, ["store_business_date"]),
    ],
    applied: ["8", "24", "1"],
    rolledBack: ["0", "0", "0"],
  },
};
