/**
 * RT-1539 — the store-scope refusals that the contract places BEFORE the Gateway (denial order,
 * contract lines "validate -> session/tenant/role/store scope"):
 *
 *   - a session platform admin is the non-disclosing 404 on this surface (AD-AI-ENT-001 D-6);
 *   - ANY requested store outside the caller's scope (the Gateway's own rule, `resolveStoreScope`) or
 *     unknown in the tenant (or deleted) refuses the WHOLE request, never narrowed, with the same 404
 *     and body as the sales reads; an empty list without tenant-wide authority is the same 404;
 *   - a tenant-wide scope with more than 500 stores is 400 `scope_too_large`.
 *
 * The route and the Gateway agree on the rule because both use `resolveStoreScope` on the same,
 * role-adjusted context (see `assertAllowed`); the Gateway re-checks it (and the entitlement port
 * re-checks that every store is live), so a refusal here is never the only line.
 */
import { BadRequestException, CanActivate, ExecutionContext, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import {
  MembershipRepository,
  findCallerRoleCode,
  isSessionPlatformAdminContext,
  resolveStoreScope,
  type ResolvedContext,
  type TenantContextRequest,
} from "../../context";
import { PG_POOL } from "../../database";
import { liveStoreIdsAfter } from "../../stores";

/** The `console-sales` 404 body: a role, a store and a platform-admin refusal cannot be told apart. */
export const NOT_FOUND_BODY = { code: "not_found", message: "Not Found" } as const;

/** More than this many stores in scope is 400 `scope_too_large` (the by-store bound). */
const SCOPE_MAX_STORES = 500;

/** Refuses a session platform admin with the non-disclosing 404, before request validation. */
@Injectable()
export class NoPlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantContextRequest>();
    if (isSessionPlatformAdminContext(request.context)) throw new NotFoundException(NOT_FOUND_BODY);
    return true;
  }
}

/** Roles whose scope is their membership's, not narrowed by the active store (RT-51 D6, as the sales reads). */
const TENANT_WIDE_ROLES: ReadonlySet<string> = new Set(["owner", "tenant_admin"]);

@Injectable()
export class ManagerSalesScope {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * Throws the 404 or the 400; otherwise returns the context the Gateway and the reads run with.
   *
   * The scope is role-aware, exactly as the sales reads' `readScope`: an `owner` or `tenant_admin` is
   * not narrowed by the session's ACTIVE store, so their context goes on with `storeId: null` and the
   * Gateway's own `coversStores` and the entitlement re-check see the same authority. A membership
   * that is `specific` stays specific (the role never widens it), and every other role (a
   * `store_manager`) keeps the active-store narrowing.
   */
  async assertAllowed(ctx: ResolvedContext, tenantId: string, storeIds: readonly string[]): Promise<ResolvedContext> {
    return await runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const role = await findCallerRoleCode(this.memberships, client, { tenantId, context: ctx });
      const effective: ResolvedContext = role !== null && TENANT_WIDE_ROLES.has(role) ? { ...ctx, storeId: null } : ctx;
      const scope = resolveStoreScope(effective);
      if (storeIds.length === 0) {
        if (scope.kind !== "tenant") throw new NotFoundException(NOT_FOUND_BODY);
        const live = await liveStoreIdsAfter(client, tenantId, { after: null, storeIds: null, limit: SCOPE_MAX_STORES + 1 });
        if (live.length > SCOPE_MAX_STORES) {
          throw new BadRequestException({ code: "scope_too_large", message: `the scope holds more than ${SCOPE_MAX_STORES} stores` });
        }
        return effective;
      }
      if (scope.kind === "stores" && !storeIds.every((id) => scope.storeIds.includes(id))) throw new NotFoundException(NOT_FOUND_BODY);
      const live = await liveStoreIdsAfter(client, tenantId, { after: null, storeIds, limit: storeIds.length + 1 });
      if (live.length !== storeIds.length) throw new NotFoundException(NOT_FOUND_BODY);
      return effective;
    });
  }
}
