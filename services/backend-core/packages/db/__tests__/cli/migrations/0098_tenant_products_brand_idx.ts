/** 0098_tenant_products_brand_idx (RT-1334): [the one valid tenant_products brand index, built CONCURRENTLY]. */
import { countValidIndexes, type MigrationEntry } from "../migration-probes";

export const MIGRATION: MigrationEntry = {
  id: "0098_tenant_products_brand_idx",
  probe: {
    measure: async (db) => [await countValidIndexes(db, ["idx_tenant_products_tenant_brand"])],
    applied: ["1"],
    rolledBack: ["0"],
  },
};
