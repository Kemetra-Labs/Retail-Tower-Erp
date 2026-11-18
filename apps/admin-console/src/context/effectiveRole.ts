/**
 * RT-1468 (owner decision 2026-11-18, "the platform admin is the superior in this system; he
 * does not need permissions or obstacles"): the role the Console gates its UI on.
 *
 * A member uses their membership role, as before. A platform admin who opened an organization
 * without a membership has no role there (`active_role_code` is null), yet Backend-Core admits
 * them to every role-gated route (RolesGuard step 4, the platform-admin bypass). So the Console
 * shows them what an owner sees. This is a rendering choice only; the server still decides.
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

export function roleCodeOf(context: RoleContext | null | undefined): string | null {
  const role = context?.active_role_code ?? null;
  if (role !== null) return role;
  const admin = context?.user?.is_platform_admin === true && context?.active_tenant != null;
  return admin ? PLATFORM_ADMIN_UI_ROLE : null;
}

/** True when the role came from the platform-admin rule above, not from a membership. */
export function isPlatformAdminRole(context: RoleContext | null | undefined): boolean {
  return (context?.active_role_code ?? null) === null && roleCodeOf(context) !== null;
}
