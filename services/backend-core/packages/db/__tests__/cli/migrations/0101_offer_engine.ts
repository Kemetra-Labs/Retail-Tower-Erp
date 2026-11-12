/**
 * 0101_offer_engine (RT-1336, RT-286 S3): [the ten Offer Engine tables, their
 * policies (10 SELECT + 10 INSERT + 4 UPDATE), their ten functions, the
 * tenant_product_categories (id, tenant_id) key].
 */
import { countFunctions, countPolicies, countTables, countValidIndexes, type MigrationEntry } from "../migration-probes";

const TABLES = [
  "offers",
  "offer_versions",
  "offer_version_stores",
  "offer_version_rules",
  "offer_pauses",
  "offer_pack_revisions",
  "offer_pack_store_revisions",
  "offer_pack_eligible_products",
  "sale_line_promotions",
  "sale_return_promotion_clawbacks",
];

const FUNCTIONS = [
  "offer_engine_append_only",
  "offers_guard",
  "offer_versions_before_insert",
  "offer_version_children_guard",
  "offer_versions_complete",
  "offer_pauses_guard",
  "offer_pack_revisions_before_insert",
  "offer_pack_store_revisions_guard",
  "offer_pack_eligible_products_guard",
  "sale_line_promotions_line_guard",
];

export const MIGRATION: MigrationEntry = {
  id: "0101_offer_engine",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countFunctions(db, FUNCTIONS),
      await countValidIndexes(db, ["uq_tenant_product_categories_id_tenant"]),
    ],
    applied: ["10", "24", "10", "1"],
    rolledBack: ["0", "0", "0", "0"],
  },
};
