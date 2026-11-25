/**
 * RF-7 (spec 016): who may open the Settings destination. The tenant's
 * admins, like the branding and cash-policy sections the page gathers;
 * the server decides every section, the nav is not an authorization decision.
 */
const SETTINGS_ROLES = ["owner", "tenant_admin"] as const;

export function canOpenSettings(role: string | null | undefined): boolean {
  return (SETTINGS_ROLES as readonly string[]).includes(role ?? "");
}
