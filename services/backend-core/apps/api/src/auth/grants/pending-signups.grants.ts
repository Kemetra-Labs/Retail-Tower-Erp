/**
 * RT-1350 slice 2 (0107): pre-tenant self-signup state. `pending_signups` is
 * read, inserted and updated by the signup service (slice 3) and holds no
 * tenant data; `user_consents` is append-only (SELECT, INSERT). Both are
 * readable and writable only inside a platform-admin context: the RLS
 * policies decide, the grants only open the door. No DELETE yet (the purge job
 * of a later slice adds `DELETE` on `pending_signups` with its own policy) and
 * never TRUNCATE (not subject to row security). The auth lookup role has
 * BYPASSRLS, so any grant would expose every pending signup's email.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["pending-signups-domain-grants.sql"],
  domainRequired: [
    ["pending_signups", "SELECT"],
    ["pending_signups", "INSERT"],
    ["pending_signups", "UPDATE"],
    ["user_consents", "SELECT"],
    ["user_consents", "INSERT"],
  ],
  lookupForbidden: [
    ["pending_signups", ALL_TABLE_PRIVILEGES],
    ["user_consents", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};
