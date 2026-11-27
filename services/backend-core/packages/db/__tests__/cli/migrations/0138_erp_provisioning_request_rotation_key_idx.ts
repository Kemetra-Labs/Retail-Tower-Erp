/** 0138_erp_provisioning_request_rotation_key_idx (RT-1362 S2): [the one valid unique index of erp_provisioning_request on (id, tenant_id, connector_registration_id, kind), the pending FK target, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0138_erp_provisioning_request_rotation_key_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["uq_erp_provisioning_request_rotation_key"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
