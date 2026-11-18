/**
 * ForceActionAccessGuard — the role and scope gate of the Console force actions
 * (RT-1437 D1; `console-force-actions.openapi.yaml`, "Auth and scope"; RT-1445).
 *
 * Runs AFTER `SessionOnlyAdminGuard` (a human cookie session only, a trusted
 * `Origin` on a write) and `TenantContextGuard` (the tenant, the membership,
 * the support-session gate), and in place of `RolesGuard`. `RolesGuard` cannot be
 * used here: its decision matrix lets every platform admin through (step 4),
 * and these operations are never open to one.
 *
 * Admitted: a tenant member whose role is `owner` or `tenant_admin` AND whose
 * membership has ALL-store access (`ctx.storeAccess.kind === 'all'`, the
 * membership's own authority, not the session's active store: a session that
 * picked one store does not narrow what its membership may do). Everything
 * else is the non-disclosing 404 (FR-ISO-4), the same body as `RolesGuard`'s
 * default: a `store_manager`, a `store_staff`, a `tenant_admin` with
 * specific-store access, a platform admin who is a member, and a caller whose
 * tenant is not the shift's.
 *
 * A platform admin who is NOT a member got here only through an active support
 * session (`TenantContextGuard` refuses the rest, 403 `support_session_*`). A
 * support session never admits these operations (D1, RT-391/RT-414): a write is
 * 403 `support_session_read_only`, a read is the 404. The tenant is the
 * session's, never the request's.
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

import { PG_POOL } from "../database";
import { MembershipRepository } from "../context/membership.repository";
import type { TenantContextRequest } from "../context/types";
import { supportSessionRefusal } from "../platform-support-sessions/support-session.gate";

const ADMITTED_ROLES: ReadonlySet<string> = new Set(["owner", "tenant_admin"]);
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** The admitted caller, published for the handler (the tenant and user are the session's). */
export interface ForceActionActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: "owner" | "tenant_admin";
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
      // A non-member platform admin is in a support session: never a write here.
      if (role === null && !SAFE_METHODS.has(request.method)) throw supportSessionRefusal("support_session_read_only");
      throw notFound();
    }
    if (role === null || !ADMITTED_ROLES.has(role)) throw notFound();
    if (ctx.storeAccess?.kind !== "all") throw notFound();

    request.forceActionActor = { tenantId, userId, role: role as ForceActionActor["role"] };
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
