/**
 * RT-1600 — the store-scope gate of the redistribution proposals (owner decision under delegation, RT-1600 review S1).
 *
 * A proposal reads and moves stock across EVERY store of the tenant, so the whole feature (compute, list, get, review,
 * accept, reject) needs tenant-wide store access. The caller's scope is the operator scope rule (RT-51 D6 / RT-131,
 * `callerStoreScope`): owner and tenant_admin are not narrowed by the active store, but a `specific` membership stays
 * specific. A store-scoped owner or tenant_admin gets the same non-disclosing 404 as every other refusal. A session
 * platform admin is admitted, as `RolesGuard` admits it on every `@Roles` operation (RT-1462 / RT-1468).
 */
import { isSessionPlatformAdminContext, type ResolvedContext, type StoreScope } from '../../context';

export function hasTenantWideAccess(context: Pick<ResolvedContext, 'isPlatformAdmin' | 'source'>, scope: StoreScope): boolean {
  return isSessionPlatformAdminContext(context) || scope.kind === 'tenant';
}
