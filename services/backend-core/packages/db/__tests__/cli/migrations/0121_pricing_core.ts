/**
 * 0121_pricing_core (RT-1151, RT-282 PR-05): the seven Retail Pricing tables, their
 * policies (7 SELECT + 7 INSERT + 5 UPDATE) and their eleven functions.
 */
import { countFunctions, countPolicies, countTables, type MigrationEntry } from "../migration-probes";

const TABLES = [
  "change_sets",
  "price_books",
  "price_zones",
  "pricing_revisions",
  "pricing_revision_stores",
  "price_zone_memberships",
  "price_events",
];

const FUNCTIONS = [
  "pricing_append_only",
  "pricing_no_delete",
  "change_sets_guard",
  "price_books_guard",
  "price_zones_guard",
  "price_books_has_default_zone",
  "pricing_revisions_before_insert",
  "pricing_revision_issued_here",
  "pricing_revision_stores_before_insert",
  "pricing_timeline_before_insert",
  "pricing_timeline_guard",
];

export const MIGRATION: MigrationEntry = {
  id: "0121_pricing_core",
  probe: {
    measure: async (db) => [
      await countTables(db, TABLES),
      await countPolicies(db, TABLES),
      await countFunctions(db, FUNCTIONS),
    ],
    applied: ["7", "19", "11"],
    rolledBack: ["0", "0", "0"],
  },
};
