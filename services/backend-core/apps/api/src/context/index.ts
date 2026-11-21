/**
 * The `context` module's port (RT-1453 module boundaries). Other modules import from here, not
 * from the files inside. RT-1470 opens it with the effective caller role; RT-1312 adds what a
 * store-scoped Console route needs: the tenant-context guard and request type, and the caller's
 * store scope (RT-193) with the membership repository that resolves it.
 */
export {
  PLATFORM_ADMIN_EFFECTIVE_ROLE,
  effectiveRoleCode,
  findCallerRoleCode,
  isSessionPlatformAdminContext,
} from "./effective-role";
export { MembershipRepository } from "./membership.repository";
export { callerStoreScope, scopeStoreIds } from "./operator-store-scope";
export { resolveStoreScope } from "./store-scope";
export type { StoreScope } from "./store-scope";
export { TenantContextGuard } from "./tenant-context.guard";
export type { ResolvedContext, TenantContextRequest } from "./types";
