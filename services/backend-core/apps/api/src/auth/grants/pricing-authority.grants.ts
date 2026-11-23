/**
 * RT-1485 (0132, spec 044 PR-16a-1): the pricing authority row and the legacy
 * cutover run records. The domain role only READS the authority row (the
 * catalogue read-down and the pricing manifest will, PR-11). It must never
 * insert, change or delete it: a runtime role that could change it could
 * unfreeze its own legacy prices. Only the cutover / rollback CLI (PR-16b) and
 * the tenants seed trigger write it. PR-16a-2a: the legacy import CLI runs as
 * the domain role and writes its watermark row, so `pricing_import_runs` gets
 * SELECT and INSERT (never UPDATE or DELETE: run rows are evidence; 0132 also
 * refuses DELETE and TRUNCATE). `pricing_cutover_runs` gets nothing until PR-16b.
 * The auth lookup role has BYPASSRLS, so any grant would expose every tenant's
 * authority and runs.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["pricing-authority-domain-grants.sql"],
  domainRequired: [
    ["tenant_pricing_authority", "SELECT"],
    ["pricing_import_runs", "SELECT"],
    ["pricing_import_runs", "INSERT"],
  ],
  lookupForbidden: [
    ["tenant_pricing_authority", ALL_TABLE_PRIVILEGES],
    ["pricing_import_runs", ALL_TABLE_PRIVILEGES],
    ["pricing_cutover_runs", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
