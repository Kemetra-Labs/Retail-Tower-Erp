/**
 * RT-451 S5 (0094): the owner-only bind appends a Tracking Resolution and its
 * line bindings; the queue read and the sale effect writer (API and worker,
 * same domain role) read them. SELECT and INSERT policies only (append-only);
 * never UPDATE, DELETE or TRUNCATE. The auth lookup role has BYPASSRLS, so any
 * grant on either table would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["tracking-resolutions-domain-grants.sql"],
  domainRequired: [
    ["tracking_resolutions", "SELECT"],
    ["tracking_resolutions", "INSERT"],
    ["tracking_resolution_lines", "SELECT"],
    ["tracking_resolution_lines", "INSERT"],
  ],
  lookupForbidden: [
    ["tracking_resolutions", ALL_TABLE_PRIVILEGES],
    ["tracking_resolution_lines", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
