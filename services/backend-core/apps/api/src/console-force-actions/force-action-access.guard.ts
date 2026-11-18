/**
 * ForceActionAccessGuard — the role and scope gate of the Console force actions
 * (RT-1437 D1; `console-force-actions.openapi.yaml`, "Auth and scope"; RT-1445;
 * RT-1462 amendment).
 *
 * Runs AFTER `SessionOnlyAdminGuard` (a human cookie session only, a trusted
 * `Origin` on a write) and `TenantContextGuard` (the tenant, the membership,
 * the support-session gate), and in place of `RolesGuard`. `RolesGuard` cannot be
 * used here: its decision matrix lets every platform admin through (step 4) with
 * no record of which authority was used, and this surface needs that record.
 *
 * Admitted:
 *   - a tenant member whose role is `owner` or `tenant_admin` AND whose
 *     membership has ALL-store access (`ctx.storeAccess.kind === 'all'`, the
 *     membership's own authority, not the session's active store: a session that
 *     picked one store does not narrow what its membership may do);
 *   - a PLATFORM ADMIN (RT-1462, owner decision 2026-11-18), whether or not they
 *     are a member of the tenant, and without a support session: these handlers
 *     are in `PLATFORM_DIRECT_HANDLERS`, so `TenantContextGuard` admits a
 *     non-member through `SupportSessionGate.admitDirect` (one
 *     `platform.cross_tenant.accessed` row per request; a suspended tenant
 *     stays read-only). The tenant is the session's active tenant, never the
 *     request's. The action is recorded as `actor_kind: platform_admin`, on
 *     behalf of that tenant and, when the caller holds one, its support
 *     session (`force-action-actor.ts`).
 *
 * Everything else is the non-disclosing 404 (FR-ISO-4), the same body as
 * `RolesGuard`'s default: a `store_manager`, a `store_staff`, a `tenant_admin`
 * with specific-store access, and a caller whose tenant is not the shift's.
 *
 * What this does NOT change: every other covered route still needs a support
 * session for a non-member, and no platform-admin database context is opened
 * here: the caller's role is read under the TENANT's own RLS context.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { type ForceActionAuditActor, platformAdminActor } from "../console-action-cap/force-action-actor";
import { MembershipRepository } from "../context/membership.repository";
import type { TenantContextRequest } from "../context/types";

const ADMITTED_ROLES: ReadonlySet<string> = new Set(["owner", "tenant_admin"]);

/** The admitted caller, published for the handler (the tenant and user are the session's). */
export interface ForceActionActor extends ForceActionAuditActor {
  readonly tenantId: string;
  readonly userId: string;
}

export type ForceActionRequest = TenantContextRequest & { forceActionActor?: ForceActionActor };

/** The admitted caller of a request that passed `ForceActionAccessGuard`. */
export function forceActionActor(request: ForceActionRequest): ForceActionActor {
  const actor = request.forceActionActor;
  if (actor === undefined) throw new UnauthorizedException("Unauthorized");
  return actor;
}

@Injectable()
export class ForceActionAccessGuard implements CanActivate {
  constructor(
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const request = execCtx.switchToHttp().getRequest<ForceActionRequest>();
    const ctx = request.context;
    if (ctx === undefined || ctx.userId === null || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
    const { userId, tenantId } = ctx;

    const role = await this.roleOf(userId, tenantId);
    if (ctx.isPlatformAdmin) {
      // RT-1462: admitted as a platform admin, whatever membership role the account also holds.
      request.forceActionActor = { tenantId, userId, ...platformAdminActor(ctx, tenantId, role) };
      return true;
    }
    if (role === null || !ADMITTED_ROLES.has(role)) throw notFound();
    if (ctx.storeAccess?.kind !== "all") throw notFound();

    request.forceActionActor = { tenantId, userId, kind: role as "owner" | "tenant_admin", role, onBehalfOf: null };
    return true;
  }

  /**
   * The user's live role in the tenant, read under the TENANT's own RLS context
   * (never a platform-admin one: RT-1389 keeps the platform-admin sites on a
   * shrink-only allowlist, and this gate needs no wider context to read the
   * caller's own membership).
   */
  private roleOf(userId: string, tenantId: string): Promise<string | null> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, (client) =>
      this.memberships.findRoleCodeForUserInTenant(userId, tenantId, client),
    );
  }
}

function notFound(): NotFoundException {
  // The same body as `RolesGuard`'s default 404 (FR-ISO-4).
  return new NotFoundException("Not Found");
}
