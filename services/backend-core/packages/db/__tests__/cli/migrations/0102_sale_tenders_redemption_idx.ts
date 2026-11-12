/** 0102_sale_tenders_redemption_idx (RT-1114): [the one valid partial unique index of sale_tenders on (tenant_id, redemption_id), built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0102_sale_tenders_redemption_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["uq_sale_tenders_tenant_redemption"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
