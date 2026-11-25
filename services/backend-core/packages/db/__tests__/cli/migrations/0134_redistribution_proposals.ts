/**
 * 0134_redistribution_proposals (RT-1600): the two redistribution proposal tables and their six policies
 * (SELECT, INSERT, UPDATE each; no DELETE).
 */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["redistribution_proposals", "redistribution_proposal_lines"];

export const MIGRATION: MigrationEntry = {
  id: "0134_redistribution_proposals",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["2", "6"],
    rolledBack: ["0", "0"],
  },
};
