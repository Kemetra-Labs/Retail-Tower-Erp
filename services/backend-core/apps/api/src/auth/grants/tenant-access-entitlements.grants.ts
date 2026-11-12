/**
 * RT-1353 (0104): the tenant access state (`restricted` / `unrestricted`).
 * The row is read by every tenant-scoped enforcement point (pairing, posting
 * row creation, the posting feed, the Console read) and written (INSERT by the
 * signup transaction of RT-1350, UPDATE by the platform-admin unlock and "mark
 * provisioned") only inside a platform-admin tenant context: the RLS policies
 * decide, the grants only open the door. Never DELETE or TRUNCATE (no row is
 * ever removed, and TRUNCATE is not subject to row security). The auth lookup
 * role has BYPASSRLS, so any grant would expose every tenant's access state.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["tenant-access-entitlements-domain-grants.sql"],
  domainRequired: [
    ["tenant_access_entitlements", "SELECT"],
    ["tenant_access_entitlements", "INSERT"],
    ["tenant_access_entitlements", "UPDATE"],
  ],
  lookupForbidden: [["tenant_access_entitlements", ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
