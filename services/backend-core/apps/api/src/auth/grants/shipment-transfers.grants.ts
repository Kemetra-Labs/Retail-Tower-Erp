/**
 * RT-1513 (0125): the shipment Transfer domain. The Transfer header, its lines and the shared reservations change
 * state, so they hold SELECT, INSERT and UPDATE; receipts, receipt lines, discrepancies and the frozen transfer leg
 * bodies are append-only (SELECT and INSERT). Never DELETE or TRUNCATE. The settings columns ride on
 * `tenant_inventory_settings` and the transit warehouse on `erpnext_warehouse_map`, whose grants are the baseline's.
 * The auth lookup role has BYPASSRLS, so any grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["shipment-transfers-domain-grants.sql"],
  domainRequired: [
    ["inventory_reservations", "SELECT"],
    ["inventory_reservations", "INSERT"],
    ["inventory_reservations", "UPDATE"],
    ["shipment_transfers", "SELECT"],
    ["shipment_transfers", "INSERT"],
    ["shipment_transfers", "UPDATE"],
    ["shipment_transfer_lines", "SELECT"],
    ["shipment_transfer_lines", "INSERT"],
    ["shipment_transfer_lines", "UPDATE"],
    ["shipment_transfer_receipts", "SELECT"],
    ["shipment_transfer_receipts", "INSERT"],
    ["shipment_transfer_receipt_lines", "SELECT"],
    ["shipment_transfer_receipt_lines", "INSERT"],
    ["shipment_transfer_discrepancies", "SELECT"],
    ["shipment_transfer_discrepancies", "INSERT"],
    ["transfer_postings", "SELECT"],
    ["transfer_postings", "INSERT"],
    ["transfer_posting_lines", "SELECT"],
    ["transfer_posting_lines", "INSERT"],
  ],
  lookupForbidden: [
    ["inventory_reservations", ALL_TABLE_PRIVILEGES],
    ["shipment_transfers", ALL_TABLE_PRIVILEGES],
    ["shipment_transfer_lines", ALL_TABLE_PRIVILEGES],
    ["shipment_transfer_receipts", ALL_TABLE_PRIVILEGES],
    ["shipment_transfer_receipt_lines", ALL_TABLE_PRIVILEGES],
    ["shipment_transfer_discrepancies", ALL_TABLE_PRIVILEGES],
    ["transfer_postings", ALL_TABLE_PRIVILEGES],
    ["transfer_posting_lines", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
