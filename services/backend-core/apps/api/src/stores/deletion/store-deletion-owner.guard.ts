/**
 * The owner gate of the store deletion surface — RT-1439 (RT-1437 D1), amended by RT-1462.
 *
 * `RolesGuard` is not enough here: its platform-admin bypass admits a platform admin before it
 * looks at roles, and it leaves no record of which authority was used. This guard decides after
 * `RolesGuard` and publishes the admitted actor (`request.storeDeletionActor`) for the audit:
 *
 *   platform admin                -> admitted (RT-1462, owner decision 2026-11-18), whether or not
 *                                    they are a tenant member and whatever role they hold there.
 *                                    These handlers are in `PLATFORM_DIRECT_HANDLERS`, so a
 *                                    non-member needs no support session (`TenantContextGuard`);
 *                                    the tenant is the session's active tenant. The row says
 *                                    `actor_kind: platform_admin`, on behalf of that tenant (and
 *                                    the support session, if the caller holds one);
 *   owner                         -> admitted;
 *   tenant_admin                  -> 403 `store_deletion_owner_only`;
 *   anything else                 -> the non-disclosing 404.
 *
 * `ReauthRoleGuard` differs in one step only: `consoleReauthenticate` checks the store before the
 * `tenant_admin` refusal (contract, evaluation order 3), so it admits a `tenant_admin` here and
 * leaves the refusal to the service, which reads `request.storeDeletionActor.kind`.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import type { Pool } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";

import { PG_POOL } from "../../auth/auth.module";
import { type ForceActionAuditActor, platformAdminActor } from "../../common/force-action-actor";
import { MembershipRepository } from "../../context/membership.repository";
import type { TenantContextRequest } from "../../context/types";
import { storeDeletionOwnerOnly, storeNotFound } from "./store-deletion.errors";

export type StoreDeletionRequestWithRole = TenantContextRequest & {
  /** The admitted caller as the audit records it (set by the guard on every admission). */
  storeDeletionActor?: ForceActionAuditActor;
};

@Injectable()
export class StoreDeletionOwnerGuard implements CanActivate {
  /** True for the re-authentication route: a `tenant_admin` is refused by the service, after the store check. */
  protected readonly deferTenantAdmin: boolean = false;

  constructor(
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Optional() @Inject(PG_POOL) private readonly pool?: Pool,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const request = execCtx.switchToHttp().getRequest<StoreDeletionRequestWithRole>();
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) throw new UnauthorizedException("Unauthorized");
    const tenantId = ctx.tenantId;
    const userId = ctx.userId;
    // The caller's OWN tenant context (RLS on memberships and roles, as the services read them): no
    // platform-admin context is needed, and a platform admin with no membership simply has no role.
    const role = this.pool
      ? await runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, (client) =>
          this.memberships.findRoleCodeForUserInTenant(userId, tenantId, client),
        )
      : await this.memberships.findRoleCodeForUserInTenant(userId, tenantId);
    if (ctx.isPlatformAdmin) {
      request.storeDeletionActor = platformAdminActor(ctx, tenantId, role);
      return true;
    }
    if (role === "owner") {
      request.storeDeletionActor = { kind: "owner", role, onBehalfOf: null };
      return true;
    }
    if (role === "tenant_admin") {
      if (!this.deferTenantAdmin) throw storeDeletionOwnerOnly();
      request.storeDeletionActor = { kind: "tenant_admin", role, onBehalfOf: null };
      return true;
    }
    throw storeNotFound();
  }
}

@Injectable()
export class ReauthRoleGuard extends StoreDeletionOwnerGuard {
  protected override readonly deferTenantAdmin: boolean = true;
}
