/**
 * RT-474: who may manage the tenant logo. Mirrors the Backend-Core role list of
 * the tenant-branding Console operations (`owner` / `tenant_admin`). Not an
 * authorization decision: the server stays the authority and answers a
 * non-disclosing 404 to anyone else.
 */
const MANAGE_ROLES: readonly string[] = ["owner", "tenant_admin"];

export function canManageLogo(role: string | null | undefined): boolean {
  return MANAGE_ROLES.includes(role ?? "");
}
