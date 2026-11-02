/**
 * The tenant role gate: `RolesGuard`'s decision for `@Roles` routes (its
 * decision-matrix steps 4 to 7), as one function a service can also call.
 *
 * RT-1061 (RT-977 §5): `consoleGetSale` shows the PII-suspect posting
 * rejection `reason` and a `repairPosting` handle only to a session that
 * `repairPosting`'s own `@Roles("owner", "tenant_admin")` gate admits. The
 * guard and the read call THIS function, so the rule that gates the reason
 * is one rule, not a second copy that can drift.
 *
 * Order (the first match wins):
 *   1. a session principal that is a platform admin → allowed (the bypass;
 *      token principals never get it, RT-132 D6 / RT-149);
 *   2. no tenant → refused (`no_tenant`);
 *   3. no user (a userless token) → refused (`no_user`);
 *   4. the user's role in the tenant is one of `accepted` → allowed;
 *      otherwise → refused (`role`).
 *
 * Pure policy: the lookups are injected, so the guard keeps its bootstrap
 * context and a service can run them on its own tenant-scoped client.
 */
import type { RoleCode } from "./roles.decorator";

export interface TenantRoleGatePrincipal {
  readonly kind: "session" | "token";
  readonly userId: string | null;
}

export interface TenantRoleGateLookups {
  /** `users.is_platform_admin` of a live user. */
  isPlatformAdmin(userId: string): Promise<boolean>;
  /** The user's active role code in the tenant, or null. */
  roleCodeInTenant(userId: string, tenantId: string): Promise<string | null>;
}

export interface TenantRoleGateInput {
  readonly principal: TenantRoleGatePrincipal;
  /** `ResolvedContext.isPlatformAdmin`, when `TenantContextGuard` resolved one. */
  readonly contextIsPlatformAdmin: boolean;
  readonly tenantId: string | null;
  readonly accepted: readonly RoleCode[];
}

export type TenantRoleGateDecision =
  | { readonly allowed: true; readonly via: "platform_admin" | "role" }
  | { readonly allowed: false; readonly reason: "no_tenant" | "no_user" | "role" };

/**
 * The platform-admin bypass: a SESSION principal whose context says so, or
 * whose user is a platform admin (path-as-context routes without
 * `TenantContextGuard`). A token principal never.
 */
export async function isSessionPlatformAdmin(
  principal: TenantRoleGatePrincipal,
  contextIsPlatformAdmin: boolean,
  lookups: Pick<TenantRoleGateLookups, "isPlatformAdmin">,
): Promise<boolean> {
  if (principal.kind !== "session" || principal.userId === null) return false;
  if (contextIsPlatformAdmin) return true;
  return await lookups.isPlatformAdmin(principal.userId);
}

export async function decideTenantRoleGate(
  input: TenantRoleGateInput,
  lookups: TenantRoleGateLookups,
): Promise<TenantRoleGateDecision> {
  if (await isSessionPlatformAdmin(input.principal, input.contextIsPlatformAdmin, lookups)) {
    return { allowed: true, via: "platform_admin" };
  }
  if (!input.tenantId) return { allowed: false, reason: "no_tenant" };
  const userId = input.principal.userId;
  if (!userId) return { allowed: false, reason: "no_user" };
  const role = await lookups.roleCodeInTenant(userId, input.tenantId);
  if (role === null || !input.accepted.some((code) => code === role)) return { allowed: false, reason: "role" };
  return { allowed: true, via: "role" };
}
