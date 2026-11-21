/**
 * 0129_retire_settlement_ledger (RT-422): drops the six spec-035 A/R ledger tables 0027 created. The
 * probe counts them: none after the migration, all six after its own down (which recreates them empty).
 */
import { countTables, type MigrationEntry } from "../migration-probes";

const RETIRED_TABLES = [
  "receivable",
  "payment_application",
  "claim",
  "claim_receivables",
  "remittance",
  "reconciliation_result",
];

export const MIGRATION: MigrationEntry = {
  id: "0129_retire_settlement_ledger",
  probe: {
    measure: async (db) => [await countTables(db, RETIRED_TABLES)],
    applied: ["0"],
    rolledBack: ["6"],
  },
};
