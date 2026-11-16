/**
 * RT-1420 (0114): Count Sessions. Sessions and lines change state, so they
 * hold SELECT, INSERT and UPDATE; the expected quantities, the observations
 * and the late-event findings are append-only (SELECT and INSERT). Never
 * DELETE or TRUNCATE. The settings columns ride on `tenant_inventory_settings`
 * whose grants are the baseline's. The auth lookup role has BYPASSRLS, so any
 * grant would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["count-sessions-domain-grants.sql"],
  domainRequired: [
    ["count_sessions", "SELECT"],
    ["count_sessions", "INSERT"],
    ["count_sessions", "UPDATE"],
    ["count_session_lines", "SELECT"],
    ["count_session_lines", "INSERT"],
    ["count_session_lines", "UPDATE"],
    ["count_session_expected", "SELECT"],
    ["count_session_expected", "INSERT"],
    ["count_observations", "SELECT"],
    ["count_observations", "INSERT"],
    ["count_late_event_findings", "SELECT"],
    ["count_late_event_findings", "INSERT"],
    ["count_late_compensations", "SELECT"],
    ["count_late_compensations", "INSERT"],
  ],
  lookupForbidden: [
    ["count_sessions", ALL_TABLE_PRIVILEGES],
    ["count_session_lines", ALL_TABLE_PRIVILEGES],
    ["count_session_expected", ALL_TABLE_PRIVILEGES],
    ["count_observations", ALL_TABLE_PRIVILEGES],
    ["count_late_event_findings", ALL_TABLE_PRIVILEGES],
    ["count_late_compensations", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
