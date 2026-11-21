/**
 * RT-1034 (0129): the worker's sync-failure alert sweep. It reads the existing
 * failure state (sales, erpnext_posting_status; already granted) and writes ONLY
 * its own two tables: windows are opened and closed (INSERT + UPDATE), deliveries
 * are claimed and moved claimed -> delivered / failed. Never DELETE or TRUNCATE.
 * The alert holds no write grant on any posting, reconciliation or sale table
 * (S13). The auth lookup role has BYPASSRLS, so any grant would expose every
 * tenant's alert state.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["sync-failure-alerts-domain-grants.sql"],
  domainRequired: [
    ["sync_failure_alert_windows", "SELECT"],
    ["sync_failure_alert_windows", "INSERT"],
    ["sync_failure_alert_windows", "UPDATE"],
    ["sync_failure_alert_deliveries", "SELECT"],
    ["sync_failure_alert_deliveries", "INSERT"],
    ["sync_failure_alert_deliveries", "UPDATE"],
  ],
  lookupForbidden: [
    ["sync_failure_alert_windows", ALL_TABLE_PRIVILEGES],
    ["sync_failure_alert_deliveries", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
