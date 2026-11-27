/** 0139_drop_auth_tokens_active_connector_credential_idx (RT-1362 S2): [drops the 0021 one-unrevoked-connector-credential index CONCURRENTLY; its down rebuilds it]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0139_drop_auth_tokens_active_connector_credential_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["uq_auth_tokens_active_connector_credential"])],
    applied: ["0"],
    rolledBack: ["1"],
  },
};
