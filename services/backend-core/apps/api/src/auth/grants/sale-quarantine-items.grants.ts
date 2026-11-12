/**
 * RT-1312 Phase 3(b) (0093): the sale quarantine runtime inserts one item per
 * first upload (INSERT) and reads items (SELECT). Every later write is a
 * column-level UPDATE (the RT-1249 mechanism): a repeat upload with other
 * facts counts a conflict; a Console repair or write-off moves the state and
 * sets its resolution, sale, repair and write-off columns; the retention purge
 * clears the body. The domain role can never rewrite the provenance, the
 * till's claim, the facts digest, the summary or the scope. No DELETE policy;
 * never DELETE or TRUNCATE. The auth lookup role has BYPASSRLS, so any grant
 * would expose every tenant's rows.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

const T = "sale_quarantine_items";

/** The columns the runtime may UPDATE; every other column is written once, at the first upload. */
export const SALE_QUARANTINE_UPDATABLE_COLUMNS = [
  "upload_conflict_count",
  "state",
  "resolved_at",
  "sale_id",
  "repair_count",
  "last_repair_at",
  "last_repair_outcome",
  "last_repair_http_status",
  "last_repair_error_code",
  "write_off_note",
  "sale_body",
  "body_purged_at",
] as const;

export const GRANTS: GrantFragment = {
  deployScripts: ["sale-quarantine-items-domain-grants.sql"],
  domainRequired: [
    [T, "SELECT"],
    [T, "INSERT"],
  ],
  domainRequiredColumns: SALE_QUARANTINE_UPDATABLE_COLUMNS.map((c) => [T, c, "UPDATE"] as const),
  lookupForbidden: [[T, ALL_TABLE_PRIVILEGES]],
  lookupAllowed: [],
};
