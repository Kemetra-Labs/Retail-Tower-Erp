/**
 * 0123_price_change_set_items_lines (RT-1151, RT-282 PR-05): the six Price
 * Change Set content tables (item lists, items, validations, lines, preview
 * lines, preview membership changes), their policies (6 SELECT + 6 INSERT + 1
 * UPDATE) and their seventeen functions (three back triggers on change_sets,
 * one on pricing_revisions).
 */
import { countFunctions, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = [
  "price_change_set_item_lists",
  "price_change_set_items",
  "price_change_set_validations",
  "price_change_set_lines",
  "price_change_set_preview_lines",
  "price_change_set_preview_memberships",
];

const FUNCTIONS = [
  "price_change_set_content_append_only",
  "price_change_set_item_lists_before_insert",
  "price_change_set_item_lists_complete",
  "price_change_set_items_before_insert",
  "price_change_set_validations_before_insert",
  "price_change_set_validations_complete",
  "price_change_set_validation_sealed",
  "price_change_set_lines_before_insert",
  "price_change_set_lines_guard",
  "price_change_set_preview_before_insert",
  "change_sets_content_rules",
  "change_sets_publish_complete",
  "change_sets_created_as_draft",
  "price_change_set_assert_tenant",
  "price_change_set_publish_record_check",
  "pricing_revisions_published",
  "change_sets_assert_legacy_import",
];

export const MIGRATION: MigrationEntry = {
  id: "0123_price_change_set_items_lines",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countFunctions(db, FUNCTIONS),
    ],
    applied: ["6", "13", "17"],
    rolledBack: ["0", "0", "0"],
  },
};
