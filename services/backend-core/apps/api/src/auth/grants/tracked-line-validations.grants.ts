/**
 * RT-451 S2 (0087): every Tracked Line Validation (`posValidateTrackedLine`)
 * appends one validation record, accepted or refused; the record is read by
 * id when a sale line cites it (RT-451 S3). SELECT and INSERT policies only
 * (append-only); never UPDATE, DELETE or TRUNCATE. The auth lookup role has
 * BYPASSRLS, so any grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["tracked-line-validations-domain-grants.sql"],
  domainRequired: [
    ["tracked_line_validations", "SELECT"],
    ["tracked_line_validations", "INSERT"],
  ],
  lookupForbidden: [["tracked_line_validations", ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
