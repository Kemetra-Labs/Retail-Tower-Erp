/** 0137_auth_tokens_current_connector_credential_idx (RT-1362 S2): [the one valid partial unique index of auth_tokens on connector_registration_id over unrevoked connector credentials with no pending marker, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0137_auth_tokens_current_connector_credential_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["uq_auth_tokens_current_connector_credential"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
