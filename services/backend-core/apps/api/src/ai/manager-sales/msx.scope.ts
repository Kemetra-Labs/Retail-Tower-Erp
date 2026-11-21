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
 * The route and the Gateway agree on the rule because both use `resolveStoreScope`; the Gateway
 * re-checks it (and the entitlement port re-checks that every store is live), so a refusal here is
 * never the only line.
 */
import { BadRequestException, CanActivate, ExecutionContext, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { isSessionPlatformAdminContext, resolveStoreScope, type ResolvedContext, type TenantContextRequest } from "../../context";
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

@Injectable()
export class ManagerSalesScope {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Throws the 404 or the 400; resolves when the requested scope may go to the Gateway. */
  async assertAllowed(ctx: ResolvedContext, tenantId: string, storeIds: readonly string[]): Promise<void> {
    const scope = resolveStoreScope(ctx);
    if (storeIds.length === 0) {
      if (scope.kind !== "tenant") throw new NotFoundException(NOT_FOUND_BODY);
      const live = await this.liveStores(tenantId, null, SCOPE_MAX_STORES + 1);
      if (live.length > SCOPE_MAX_STORES) {
        throw new BadRequestException({ code: "scope_too_large", message: `the scope holds more than ${SCOPE_MAX_STORES} stores` });
      }
      return;
    }
    if (scope.kind === "stores" && !storeIds.every((id) => scope.storeIds.includes(id))) throw new NotFoundException(NOT_FOUND_BODY);
    const live = await this.liveStores(tenantId, storeIds, storeIds.length + 1);
    if (live.length !== storeIds.length) throw new NotFoundException(NOT_FOUND_BODY);
  }

  private liveStores(tenantId: string, storeIds: readonly string[] | null, limit: number): Promise<string[]> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, (client) =>
      liveStoreIdsAfter(client, tenantId, { after: null, storeIds, limit }),
    );
  }
}
