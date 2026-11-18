/**
 * RT-1470 (owner decision 2026-11-18, RT-1468 comment 17463: "the platform admin is the superior in
 * this system; he does not need permissions or obstacles"): the role a service decides with.
 *
 * `RolesGuard` step 4 already lets a session platform admin past `@Roles`, and `TenantContextGuard`
 * admits them to every tenant with store access "all". Services that read the caller's role
 * themselves (capabilities, owner-only rules, the operator store scope) used the membership role,
 * which is `null` for a platform admin who is not a member and narrower for one who is. They decide
 * with this effective role instead: a session platform admin is an owner, member or not.
 *
 * Only for what the CALLER may do. A role written into an audit record stays the real membership
 * role (`shift-force-close.audit.ts`, the store-deletion audit), and another user's role (a member
 * being changed) is never touched. A bearer token never counts, whatever its user (RT-132 D6).
 * The handler's RLS context stays `isPlatformAdmin: false` inside the tenant (RT-142).
 */
import type { PoolClient } from "pg";

import type { MembershipRepository } from "./membership.repository";
import type { ResolvedContext } from "./types";

/** The role a session platform admin decides with, in any tenant. */
export const PLATFORM_ADMIN_EFFECTIVE_ROLE = "owner";

type CallerFlags = Pick<ResolvedContext, "isPlatformAdmin" | "source">;

/** A platform admin on a cookie session. A token never qualifies (RT-132 D6). */
export function isSessionPlatformAdminContext(context: CallerFlags | null | undefined): boolean {
  return context?.isPlatformAdmin === true && context.source === "session";
}

/** The caller's effective role from an already-read membership role. */
export function effectiveRoleCode(
  context: CallerFlags | null | undefined,
  membershipRole: string | null,
): string | null {
  return isSessionPlatformAdminContext(context) ? PLATFORM_ADMIN_EFFECTIVE_ROLE : membershipRole;
}

/**
 * The caller's effective role in `tenantId`: owner for a session platform admin (no lookup), else
 * the active membership role or null. `client` must run under the tenant's context (RLS).
 */
export async function findCallerRoleCode(
  memberships: Pick<MembershipRepository, "findRoleCodeForUserInTenant">,
  client: PoolClient,
  input: { readonly tenantId: string; readonly context: ResolvedContext },
): Promise<string | null> {
  if (isSessionPlatformAdminContext(input.context)) return PLATFORM_ADMIN_EFFECTIVE_ROLE;
  const userId = input.context.userId;
  return userId === null
    ? null
    : await memberships.findRoleCodeForUserInTenant(userId, input.tenantId, client);
}
