/**
 * RT-1468 (owner decision 2026-11-18, "the platform admin is the superior in this system; he
 * does not need permissions or obstacles"): the role the Console gates its UI on.
 *
 * A user who is not a platform admin uses their membership role, as before. A platform admin is
 * admitted by Backend-Core to every role-gated route of the organization they opened, whatever
 * their membership (RolesGuard step 4, the platform-admin bypass; `active_role_code` is null when
 * they are not a member). So the Console shows them what an owner sees. This is a rendering
 * choice only; the server still decides.
 *
 * The server's `active_role_code` is never rewritten: the shell labels such a user
 * "Platform admin", not "Owner".
 */
export const PLATFORM_ADMIN_UI_ROLE = "owner";

interface RoleContext {
  user?: { is_platform_admin?: boolean } | null;
  active_tenant?: { id?: string } | null;
  active_role_code?: string | null;
}

/** True when the platform-admin rule below applies: a platform admin with an organization open. */
export function isPlatformAdminRole(context: RoleContext | null | undefined): boolean {
  return context?.user?.is_platform_admin === true && context?.active_tenant != null;
}

/**
 * The store scope the UI assumes. A platform admin with an organization open reaches every store
 * (TenantContextGuard admits them to all stores, whatever the membership), so "all".
 */
export function storeAccessOf(
  context: RoleContext | null | undefined,
  membership: { store_access_kind?: "all" | "specific" } | null | undefined,
): "all" | "specific" | undefined {
  return isPlatformAdminRole(context) ? "all" : membership?.store_access_kind;
}

export function roleCodeOf(context: RoleContext | null | undefined): string | null {
  if (isPlatformAdminRole(context)) return PLATFORM_ADMIN_UI_ROLE;
  return context?.active_role_code ?? null;
}
