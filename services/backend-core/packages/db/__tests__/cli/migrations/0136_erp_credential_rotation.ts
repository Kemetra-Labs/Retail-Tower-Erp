/**
 * 0136_erp_credential_rotation (RT-1362 S2): the routed host label and trigger columns of a `credential.rotate`
 * request with their CHECK, and the adopted registration's provisioner host binding (three columns and their CHECK).
 */
import { countColumns, countConstraints, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0136_erp_credential_rotation",
  probe: {
    measure: async (db) => [
      await countColumns(db, "erp_provisioning_request", ["routed_host_label", "rotation_trigger"]),
      await countColumns(db, "connector_registration", [
        "provisioner_host_label",
        "provisioner_host_binding",
        "provisioner_host_binding_revision",
      ]),
      await countConstraints(db, [
        "erp_provisioning_request_rotation_shape",
        "connector_registration_provisioner_host_binding_valid",
      ]),
    ],
    applied: ["2", "3", "2"],
    rolledBack: ["0", "0", "0"],
  },
};
