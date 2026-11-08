/**
 * RT-451 S3 (0089): sale capture appends the G7-9 row-2 and row-3 findings to
 * `sale_line_findings` and `listSaleLineFindings` reads them. SELECT and
 * INSERT policies only (append-only); never UPDATE, DELETE or TRUNCATE.
 * Capture also reads the ERP edge map (`erpnext_tracking_map`, 0045) to find an
 * identity with no ERP Batch (`erp_intent_held` / `edge_map_missing`): SELECT
 * only, since nothing in the API writes the edge map. The auth lookup role has
 * BYPASSRLS, so any grant on either table would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["sale-line-findings-domain-grants.sql"],
  domainRequired: [
    ["sale_line_findings", "SELECT"],
    ["sale_line_findings", "INSERT"],
    ["erpnext_tracking_map", "SELECT"],
  ],
  lookupForbidden: [["sale_line_findings", ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
