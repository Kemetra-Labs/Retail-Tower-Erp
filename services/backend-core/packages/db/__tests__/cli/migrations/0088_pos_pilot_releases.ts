/** 0088_pos_pilot_releases (RT-1292): [the pilot release registry and the pilot tenant allowlist, their six policies (3 each)]. */
import { countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["pos_pilot_release_registry", "pos_pilot_tenant_allowlist"];

export const MIGRATION: MigrationEntry = {
  id: "0088_pos_pilot_releases",
  probe: {
    measure: async (db) => [await countTables(db, TABLES), await countPolicies(db, TABLES)],
    applied: ["2", "6"],
    rolledBack: ["0", "0"],
  },
};
