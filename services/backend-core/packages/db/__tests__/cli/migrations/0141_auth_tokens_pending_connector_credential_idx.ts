/** 0141_auth_tokens_pending_connector_credential_idx (RT-1362 S2): [the one valid partial unique index of auth_tokens on connector_registration_id over unrevoked pending connector credentials, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0141_auth_tokens_pending_connector_credential_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["uq_auth_tokens_pending_connector_credential"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
