/**
 * RT-1485 (0132, spec 044 PR-16a-1): the pricing authority row and the legacy
 * cutover run records. The domain role only READS the authority row (the
 * catalogue read-down and the pricing manifest will, PR-11). It must never
 * insert, change or delete it: a runtime role that could change it could
 * unfreeze its own legacy prices. Only the cutover / rollback CLI (PR-16b) and
 * the tenants seed trigger write it. The run tables get no domain grant until
 * the slices that write them (PR-16a-2, PR-16b). The auth lookup role has
 * BYPASSRLS, so any grant would expose every tenant's authority and runs.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["pricing-authority-domain-grants.sql"],
  domainRequired: [["tenant_pricing_authority", "SELECT"]],
  lookupForbidden: [
    ["tenant_pricing_authority", ALL_TABLE_PRIVILEGES],
    ["pricing_import_runs", ALL_TABLE_PRIVILEGES],
    ["pricing_cutover_runs", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
