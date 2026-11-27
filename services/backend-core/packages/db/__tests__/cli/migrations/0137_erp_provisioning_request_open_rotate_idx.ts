/** 0137_erp_provisioning_request_open_rotate_idx (RT-1362 S2): [the one valid partial unique index of erp_provisioning_request on connector_registration_id over open credential.rotate requests, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0137_erp_provisioning_request_open_rotate_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["uq_erp_provisioning_request_open_credential_rotate"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
