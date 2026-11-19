/**
 * RT-1151 (0123, RT-282 PR-05): the Retail Pricing runtime (RT-1484) reads and
 * inserts a Change Set's item lists, items, validations (with the stored
 * Impact Preview), materialized lines and preview rows. The only UPDATE is
 * column-level (RT-1249 mechanism): `price_change_set_lines (new_event_id,
 * result_ids)`, the publish record the 0123 guard lets the publishing
 * transaction set once. Everything else is insert-only. No DELETE policy;
 * never DELETE or TRUNCATE. The auth lookup role has BYPASSRLS, so any grant
 * would expose every tenant's pricing work.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

const TABLES = [
  "price_change_set_item_lists",
  "price_change_set_items",
  "price_change_set_validations",
  "price_change_set_lines",
  "price_change_set_preview_lines",
  "price_change_set_preview_memberships",
] as const;

export const GRANTS: GrantFragment = {
  deployScripts: ["price-change-set-content-domain-grants.sql"],
  domainRequired: TABLES.flatMap((t) => [
    [t, "SELECT"],
    [t, "INSERT"],
  ]),
  domainRequiredColumns: [
    ["price_change_set_lines", "new_event_id", "UPDATE"],
    ["price_change_set_lines", "result_ids", "UPDATE"],
  ],
  lookupForbidden: TABLES.map((t) => [t, ALL_TABLE_PRIVILEGES]),
  lookupAllowed: [],
};
