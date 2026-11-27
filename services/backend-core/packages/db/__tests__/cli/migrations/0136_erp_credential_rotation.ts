/**
 * 0136_erp_credential_rotation (RT-1362 S2): the pending marker on auth_tokens (column, composite FK, shape CHECK),
 * the routing and trigger columns of a `credential.rotate` request with their CHECK, the one-open-rotation partial
 * unique index, and the adopted registration's provisioner host binding (three columns and their CHECK).
 */
import { countColumns, countConstraints, countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0136_erp_credential_rotation",
  probe: {
    measure: async (db) => [
      await countColumns(db, "auth_tokens", ["pending_rotation_request_id"]),
      await countColumns(db, "erp_provisioning_request", ["routed_host_label", "rotation_trigger"]),
      await countColumns(db, "connector_registration", [
        "provisioner_host_label",
        "provisioner_host_binding",
        "provisioner_host_binding_revision",
      ]),
      await countConstraints(db, [
        "auth_tokens_pending_rotation_request_fk",
        "auth_tokens_pending_rotation_shape",
        "erp_provisioning_request_rotation_shape",
        "connector_registration_provisioner_host_binding_valid",
      ]),
      await countValidIndexes(db, ["uq_erp_provisioning_request_open_credential_rotate"]),
    ],
    applied: ["1", "2", "3", "4", "1"],
    rolledBack: ["0", "0", "0", "0", "0"],
  },
};
