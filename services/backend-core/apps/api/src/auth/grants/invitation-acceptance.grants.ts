/**
 * RT-937 (owner decision, RT-791 c13436 / c13437; no migration): accepting an
 * invitation for a NEW user creates the user, links its external identity and
 * grants the invited membership in ONE domain-role transaction, and marks the
 * invitation accepted. No runtime code inserted `users` or
 * `external_identity_links` before this; only owner-run CLIs did.
 *
 *   - users, external_identity_links: INSERT. Never UPDATE, DELETE or TRUNCATE
 *     here: a link is flipped by the owner-run cutover CLI, not by this path.
 *   - memberships, store_access: INSERT (the grant of the invited membership).
 *   - invitations: UPDATE (the single-use acceptance mark).
 *
 * The auth lookup role keeps its own, smaller grants (database-roles.md): it
 * must hold no membership mutation, which the baseline already forbids.
 */
import type { GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["invitation-acceptance-domain-grants.sql"],
  domainRequired: [
    ["users", "INSERT"],
    ["external_identity_links", "INSERT"],
    ["memberships", "INSERT"],
    ["store_access", "INSERT"],
    ["invitations", "UPDATE"],
  ],
  lookupForbidden: [],
  lookupAllowed: [],
};
