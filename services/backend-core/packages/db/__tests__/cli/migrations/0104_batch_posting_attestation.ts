/** 0104_batch_posting_attestation (RT-452): [its three tenant_inventory_settings columns, their two CHECKs]. */
import { countColumns, countConstraints, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0104_batch_posting_attestation",
  probe: {
    measure: async (db) => [
      await countColumns(db, "tenant_inventory_settings", [
        "erp_batch_posting_attested_at",
        "erp_batch_posting_attested_by",
        "erp_batch_posting_evidence_ref",
      ]),
      await countConstraints(db, [
        "tenant_inventory_settings_batch_posting_attest_together",
        "tenant_inventory_settings_batch_posting_evidence_ref",
      ]),
    ],
    applied: ["3", "2"],
    rolledBack: ["0", "0"],
  },
};
