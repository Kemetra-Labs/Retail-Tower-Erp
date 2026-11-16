/**
 * RT-1423 (0116): the frozen body of a count chunk and the per-line result the Connector reported change
 * state on ack, so `count_posting_lines` holds SELECT, INSERT and UPDATE. Never DELETE or TRUNCATE. The
 * chunk columns ride on `erpnext_posting_status`, whose grants are unchanged. The auth lookup role has
 * BYPASSRLS, so any grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["count-posting-domain-grants.sql"],
  domainRequired: [
    ["count_posting_lines", "SELECT"],
    ["count_posting_lines", "INSERT"],
    ["count_posting_lines", "UPDATE"],
  ],
  lookupForbidden: [["count_posting_lines", ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
