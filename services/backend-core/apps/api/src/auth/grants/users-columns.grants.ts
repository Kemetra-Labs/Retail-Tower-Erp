/**
 * RT-1249 (RT-147 probe 5, owner-approved on RT-1249): the domain role reaches
 * `users` column by column, never `password_hash`. Only the auth lookup role
 * reads and writes password hashes (sign-in, rehash, reset); `users` has no
 * RLS, so a table-level grant would expose every tenant's hashes.
 *
 * The columns, each with the domain code that needs it (every other read of
 * `users` runs on the auth lookup pool, which keeps its own grants):
 *
 *   SELECT
 *     id                 every join and lookup by user (membership.repository,
 *                        memberships.repository, invitations, console-people,
 *                        sale-history.reads, pos-shifts, shift-store-user,
 *                        cashier-eligibility, approver-eligibility,
 *                        pos-operators.service, support-session.origin-audit)
 *     email              membership.repository (listForTenant, findUserSummary),
 *                        memberships.repository, invitations.repository
 *                        (findUserByEmail)
 *     display_name       membership.repository, memberships.repository,
 *                        invitations.repository, console-people, sale-history,
 *                        pos-shifts, cashier-eligibility, pos-operators.service
 *     is_platform_admin  membership.repository (isPlatformAdmin,
 *                        findUserSummary), invitations.service,
 *                        support-session.origin-audit
 *     deleted_at         the live-user filter of every read above
 *   INSERT (RT-937, invitations.repository insertUser: a new user has no
 *          local password, so password_hash stays NULL)
 *     id, email, display_name, email_verified_at
 *
 * No UPDATE: no domain code updates `users`. The table-wide DELETE the lab
 * role still holds is a separate owner decision (RT-1249, out of scope); this
 * script neither grants nor revokes it.
 *
 * `password_hash` is forbidden to the domain role by the boot check itself
 * (DOMAIN_FORBIDDEN_COLUMN_GRANTS in database-pools.ts), not by a fragment.
 */
import type { GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["users-columns-domain-grants.sql"],
  domainRequired: [],
  domainRequiredColumns: [
    ["users", "id", "SELECT"],
    ["users", "email", "SELECT"],
    ["users", "display_name", "SELECT"],
    ["users", "is_platform_admin", "SELECT"],
    ["users", "deleted_at", "SELECT"],
    ["users", "id", "INSERT"],
    ["users", "email", "INSERT"],
    ["users", "display_name", "INSERT"],
    ["users", "email_verified_at", "INSERT"],
  ],
  lookupForbidden: [],
  lookupAllowed: [],
};
