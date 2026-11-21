/**
 * RT-1541: who sees the Manager Sales Ask/Explain panel, and the rollout flag.
 *
 * Two gates, both UX only: the server stays the authority (RT-1538: a role outside the list, a
 * platform admin and an out-of-scope store all get the same non-disclosing 404). The panel is
 * shown only when
 *   1. the default-OFF UI rollout flag `VITE_AI_MANAGER_SALES_PANEL` is exactly "true" (unset in
 *      every committed config, so OFF), AND
 *   2. the signed-in role is owner, tenant_admin or store_manager, AND the user is not a platform
 *      admin. The Console otherwise shows a platform admin what an owner sees (RT-1468,
 *      `roleCodeOf`), so this gate reads the platform-admin fact itself instead of `roleCodeOf`:
 *      the contract refuses a platform admin on this surface (AD-AI-ENT-001 D-6).
 */
import { isPlatformAdminRole } from "@/context/effectiveRole";

export const MANAGER_SALES_ROLES: readonly string[] = ["owner", "tenant_admin", "store_manager"];

/** The build-time rollout flag. Only the exact string "true" is ON. */
export function isManagerSalesFlagOn(): boolean {
  return import.meta.env.VITE_AI_MANAGER_SALES_PANEL === "true";
}

interface AccessContext {
  user?: { is_platform_admin?: boolean } | null;
  active_tenant?: { id?: string } | null;
  active_role_code?: string | null;
}

/**
 * The membership role that may see the panel, or null. A platform admin never gets it, whatever
 * their membership role.
 */
export function managerSalesRoleOf(context: AccessContext | null | undefined): string | null {
  if (context?.user?.is_platform_admin === true || isPlatformAdminRole(context)) return null;
  const role = context?.active_role_code ?? "";
  return MANAGER_SALES_ROLES.includes(role) ? role : null;
}
