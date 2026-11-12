/**
 * RT-1288 (0096): the ERP-origin stock import feed and report
 * (`erpnext-connector/stock-import.yaml`). The pull opens import runs and pages
 * (INSERT) and closes stale ones (UPDATE); the report records the page
 * (UPDATE), closes or advances its run, and appends one record per reported row
 * and one per finding. Rows and findings have SELECT and INSERT policies only
 * (append-only). Never DELETE or TRUNCATE. The auth lookup role has BYPASSRLS,
 * so any grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["erp-stock-import-domain-grants.sql"],
  domainRequired: [
    ["erp_stock_import_runs", "SELECT"],
    ["erp_stock_import_runs", "INSERT"],
    ["erp_stock_import_runs", "UPDATE"],
    ["erp_stock_import_pages", "SELECT"],
    ["erp_stock_import_pages", "INSERT"],
    ["erp_stock_import_pages", "UPDATE"],
    ["erp_stock_import_rows", "SELECT"],
    ["erp_stock_import_rows", "INSERT"],
    ["erp_stock_import_findings", "SELECT"],
    ["erp_stock_import_findings", "INSERT"],
  ],
  lookupForbidden: [
    ["erp_stock_import_runs", ALL_TABLE_PRIVILEGES],
    ["erp_stock_import_pages", ALL_TABLE_PRIVILEGES],
    ["erp_stock_import_rows", ALL_TABLE_PRIVILEGES],
    ["erp_stock_import_findings", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
