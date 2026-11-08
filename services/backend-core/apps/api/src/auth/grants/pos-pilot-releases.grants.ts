/**
 * RT-1292 (0088): the console resolver reads the pilot registry and the
 * allowlist; the platform-admin routes add and remove allowlist rows; the
 * (later) registry writes create and update registry rows. The registry has no
 * DELETE policy and the allowlist no UPDATE policy; never DELETE or TRUNCATE the
 * registry. The auth lookup role has BYPASSRLS, so any grant would expose every
 * tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["pos-pilot-releases-domain-grants.sql"],
  domainRequired: [
    ["pos_pilot_release_registry", "SELECT"],
    ["pos_pilot_release_registry", "INSERT"],
    ["pos_pilot_release_registry", "UPDATE"],
    ["pos_pilot_tenant_allowlist", "SELECT"],
    ["pos_pilot_tenant_allowlist", "INSERT"],
    ["pos_pilot_tenant_allowlist", "DELETE"],
  ],
  lookupForbidden: [
    ["pos_pilot_release_registry", ALL_TABLE_PRIVILEGES],
    ["pos_pilot_tenant_allowlist", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
