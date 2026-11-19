/**
 * RT-1151 (0121, RT-282 PR-05): the Retail Pricing runtime (RT-1484) reads and
 * inserts on all seven tables. UPDATE is column-level only (RT-1249
 * mechanism): a Change Set's lifecycle columns; a Book's name; a Zone's name and
 * retirement; and ending an event or membership (state + ended_in_revision).
 * The 0121 guard triggers bound each of those further. Pricing revisions and
 * the Store fan-out are append-only (no UPDATE). No DELETE policy anywhere;
 * never DELETE or TRUNCATE. The auth lookup role has BYPASSRLS, so any grant
 * would expose every tenant's prices.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

const TABLES = [
  "change_sets",
  "price_books",
  "price_zones",
  "pricing_revisions",
  "pricing_revision_stores",
  "price_zone_memberships",
  "price_events",
] as const;

const CHANGE_SET_UPDATE_COLUMNS = [
  "title",
  "reason",
  "state",
  "version",
  "validated_at_revision",
  "preview_hash",
  "target_store_set_hash",
  "sensitive",
  "sensitivity_reasons",
  "revision_no",
  "submitted_by_user_id",
  "submitted_at",
  "approved_by_user_id",
  "approved_at",
  "published_by_user_id",
  "published_at",
  "cancelled_by_user_id",
  "cancelled_at",
  "rejected_by_user_id",
  "rejected_at",
  "rejection_reason",
  // 0123: the versions holding the item list and the latest validation.
  "items_version",
  "lines_version",
] as const;

export const GRANTS: GrantFragment = {
  deployScripts: ["pricing-domain-grants.sql"],
  domainRequired: TABLES.flatMap((t) => [
    [t, "SELECT"],
    [t, "INSERT"],
  ]),
  domainRequiredColumns: [
    ...CHANGE_SET_UPDATE_COLUMNS.map((c) => ["change_sets", c, "UPDATE"] as const),
    ["price_books", "name", "UPDATE"],
    ["price_zones", "name", "UPDATE"],
    ["price_zones", "retired_at", "UPDATE"],
    ["price_zones", "retired_by_user_id", "UPDATE"],
    ["price_zones", "retire_reason", "UPDATE"],
    ["price_zone_memberships", "state", "UPDATE"],
    ["price_zone_memberships", "ended_in_revision", "UPDATE"],
    ["price_events", "state", "UPDATE"],
    ["price_events", "ended_in_revision", "UPDATE"],
  ],
  lookupForbidden: TABLES.map((t) => [t, ALL_TABLE_PRIVILEGES]),
  lookupAllowed: [],
};
