/** 0100_sale_lines_promotion_key_idx (RT-1336, RT-286 S3): [the one valid sale_lines composite key index, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0100_sale_lines_promotion_key_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["uq_sale_lines_id_sale_tenant_store"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
