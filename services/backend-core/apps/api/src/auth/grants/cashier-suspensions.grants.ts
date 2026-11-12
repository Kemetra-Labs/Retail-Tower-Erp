/**
 * RT-1138 (0106): the per-store cashier suspension state. The domain role reads
 * it (cashier admission, the POS roster, the Console list) and writes it (the
 * suspend and reactivate routes): the RLS policies fence each tenant to its own
 * rows, the grants only open the door. Never DELETE or TRUNCATE (no row is ever
 * removed, and TRUNCATE is not subject to row security). The auth lookup role
 * has BYPASSRLS, so any grant would expose every tenant's suspensions.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["cashier-suspensions-domain-grants.sql"],
  domainRequired: [
    ["cashier_suspensions", "SELECT"],
    ["cashier_suspensions", "INSERT"],
    ["cashier_suspensions", "UPDATE"],
  ],
  lookupForbidden: [["cashier_suspensions", ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
