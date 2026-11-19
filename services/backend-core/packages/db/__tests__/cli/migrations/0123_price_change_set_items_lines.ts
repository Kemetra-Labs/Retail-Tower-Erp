/**
 * 0123_price_change_set_items_lines (RT-1151, RT-282 PR-05): the Change Set
 * items and lines tables, their policies (2 SELECT + 2 INSERT + 1 UPDATE) and
 * their five functions (one is a trigger on change_sets, which also gains two columns).
 */
import { countFunctions, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = ["price_change_set_items", "price_change_set_lines"];

const FUNCTIONS = [
  "price_change_set_items_before_insert",
  "price_change_set_content_append_only",
  "price_change_set_lines_before_insert",
  "price_change_set_lines_guard",
  "change_sets_content_versions",
];

export const MIGRATION: MigrationEntry = {
  id: "0123_price_change_set_items_lines",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countFunctions(db, FUNCTIONS),
    ],
    applied: ["2", "5", "5"],
    rolledBack: ["0", "0", "0"],
  },
};
