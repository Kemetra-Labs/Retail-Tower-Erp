/**
 * RT-453 (0102): Tracking Identity birth from ERP evidence and the
 * per-identity Inventory Anchor. The worker (tracking master read of a 017
 * stock run) and the API (stock import report) birth identities: INSERT on
 * `tracking_identities` and `erpnext_tracking_map` (0045's INSERT policies;
 * SELECT is already granted) and one `tracking_identity_births` record each.
 * The import report resolves `awaiting_identity` rows (one resolution each).
 * The anchor CLI writes `inventory_identity_anchors` and their lines, and the
 * 017 run and the Q13 checks read them (API, worker and CLI share this role).
 * Every table here is append-only (SELECT and INSERT policies only); never
 * UPDATE, DELETE or TRUNCATE. The auth lookup role has BYPASSRLS, so any grant
 * would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

const NEW_TABLES = [
  "tracking_identity_births",
  "erp_stock_import_row_resolutions",
  "inventory_identity_anchors",
  "inventory_identity_anchor_lines",
] as const;

export const GRANTS: GrantFragment = {
  deployScripts: ["tracking-identity-birth-domain-grants.sql"],
  domainRequired: [
    ["tracking_identities", "INSERT"],
    ["erpnext_tracking_map", "INSERT"],
    ...NEW_TABLES.flatMap((table) => [
      [table, "SELECT"] as const,
      [table, "INSERT"] as const,
    ]),
  ],
  lookupForbidden: NEW_TABLES.map((table) => [table, ALL_TABLE_PRIVILEGES] as const),
  lookupAllowed: [],
};
