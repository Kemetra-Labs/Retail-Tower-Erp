/**
 * The owner gate of the store deletion surface — RT-1439 (RT-1437 D1).
 *
 * `RolesGuard` is not enough here: its platform-admin bypass admits a platform admin before it
 * looks at roles, and the support-session gate admits a platform admin's writes on an active
 * tenant. This guard decides from the caller's ROLE IN THE TENANT, after `RolesGuard`:
 *
 *   owner                         -> admitted;
 *   tenant_admin                  -> 403 `store_deletion_owner_only`;
 *   no membership, platform admin -> 403 `support_session_read_only` (a support session never
 *                                    admits these operations; no write here is a break-glass);
 *   anything else                 -> the non-disclosing 404.
 *
 * `ReauthRoleGuard` differs in one step only: `consoleReauthenticate` checks the store before the
 * `tenant_admin` refusal (contract, evaluation order 3), so it admits a `tenant_admin` here and
 * leaves the refusal to the service, which reads the role from `request.storeDeletionRole`.
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

import { PG_POOL } from "../../database";
import { MembershipRepository } from "../../context/membership.repository";
import type { TenantContextRequest } from "../../context/types";
import {
  storeDeletionOwnerOnly,
  storeNotFound,
  supportSessionReadOnly,
} from "./store-deletion.errors";

export type StoreDeletionRequestWithRole = TenantContextRequest & { storeDeletionRole?: string | null };

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
    request.storeDeletionRole = role;
    if (role === "owner") return true;
    if (role === "tenant_admin") {
      if (this.deferTenantAdmin) return true;
      throw storeDeletionOwnerOnly();
    }
    if (role === null && ctx.isPlatformAdmin) throw supportSessionReadOnly();
    throw storeNotFound();
  }
}

@Injectable()
export class ReauthRoleGuard extends StoreDeletionOwnerGuard {
  protected override readonly deferTenantAdmin: boolean = true;
}
