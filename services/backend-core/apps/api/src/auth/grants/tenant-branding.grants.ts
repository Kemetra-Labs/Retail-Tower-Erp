/**
 * RT-473 S2 (0076): the tenant logo save / remove and the Console and POS
 * branding reads. The revision counter is created and moved up, never deleted
 * (no DELETE policy); a logo is deleted on remove and its renditions go with it
 * (ON DELETE CASCADE) and are upserted on replace. The auth lookup role has
 * BYPASSRLS, so any grant would expose every tenant's logo.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["tenant-branding-domain-grants.sql"],
  domainRequired: [
    ["tenant_branding_revisions", "SELECT"],
    ["tenant_branding_revisions", "INSERT"],
    ["tenant_branding_revisions", "UPDATE"],
    ["tenant_logos", "SELECT"],
    ["tenant_logos", "INSERT"],
    ["tenant_logos", "UPDATE"],
    ["tenant_logos", "DELETE"],
    ["tenant_logo_renditions", "SELECT"],
    ["tenant_logo_renditions", "INSERT"],
    ["tenant_logo_renditions", "UPDATE"],
  ],
  lookupForbidden: [
    ["tenant_branding_revisions", ALL_TABLE_PRIVILEGES],
    ["tenant_logos", ALL_TABLE_PRIVILEGES],
    ["tenant_logo_renditions", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
