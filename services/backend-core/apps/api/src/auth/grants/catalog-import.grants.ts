/**
 * RT-1503 (0124, spec 049 S2): the manual product import runtime (RT-1505,
 * RT-1507) and its retention / expiry worker read, insert and update the three
 * import tables. DELETE on catalog_import_rows only: a re-upload replaces the
 * old file's rows and the retention purge removes them (OD-6). The batches
 * (the lasting import summary; a 0124 trigger refuses DELETE and TRUNCATE for
 * every role) and the mapping profiles have no DELETE policy and get no
 * DELETE. The auth lookup role has BYPASSRLS, so any grant would expose every
 * tenant's staged catalogue rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

const TABLES = ["catalog_import_mapping_profiles", "catalog_import_batches", "catalog_import_rows"] as const;

export const GRANTS: GrantFragment = {
  deployScripts: ["catalog-import-domain-grants.sql"],
  domainRequired: [
    ...TABLES.flatMap((t) => [
      [t, "SELECT"] as const,
      [t, "INSERT"] as const,
      [t, "UPDATE"] as const,
    ]),
    ["catalog_import_rows", "DELETE"],
  ],
  lookupForbidden: TABLES.map((t) => [t, ALL_TABLE_PRIVILEGES]),
  lookupAllowed: [],
};
