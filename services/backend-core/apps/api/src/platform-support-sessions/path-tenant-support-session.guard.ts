/**
 * PathTenantSupportSessionGuard — the cross-tenant record on the two path-tenant
 * routes that reach one tenant's data without `TenantContextGuard`:
 * `listMembers` (`GET /api/v1/tenants/{tenant_id}/members`) and `updateTenant`
 * (`PATCH /api/v1/tenants/{tenant_id}`) (owner decision 6, 2026-10-12).
 *
 * Mounted BEFORE `RolesGuard` and before the handler's UUID pipe:
 *
 *   - not a cookie session, or not a platform admin → pass; `RolesGuard`
 *     decides as before;
 *   - a path segment that is not a UUID or names no tenant → 403
 *     `support_session_required` (FR-ISO-4), with a platform-scoped row
 *     (`tenant_id` null);
 *   - otherwise `SupportSessionGate.admit`: since RT-1468 every platform admin
 *     (member or not, no support session needed, suspended tenant included) is
 *     admitted and the request writes one `platform.cross_tenant.accessed` row.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Pool } from "pg";

import type { AuthedRequest } from "../auth/auth.guard";
import { PG_POOL } from "../auth/database-pools";
import { assignRequestId } from "../common/request-id.interceptor";
import { MembershipRepository } from "../context/membership.repository";
import { PATH_TENANT_HANDLERS, handlerKey, routeTemplate } from "./support-session.coverage";
import { SupportSessionGate, type GateRequest } from "./support-session.gate";

@Injectable()
export class PathTenantSupportSessionGuard implements CanActivate {
  private readonly gate: SupportSessionGate;

  constructor(
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Inject(PG_POOL) pool: Pool,
  ) {
    this.gate = new SupportSessionGate(pool);
  }

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const request = execCtx.switchToHttp().getRequest<AuthedRequest>();
    const principal = request.principal;
    if (principal?.kind !== "session") return true;
    if (!(await this.memberships.isPlatformAdmin(principal.userId))) return true;

    const { tenantId, gateRequest } = describeRequest(execCtx, request, principal);

    if (!(await this.gate.tenantRowExists(tenantId))) {
      return this.gate.refuseUnresolvable(gateRequest);
    }
    // RT-1468: every platform admin (member or not) is admitted and recorded.
    await this.gate.admit(tenantId, gateRequest);
    return true;
  }
}

/** The path tenant and the facts its audit row records. */
function describeRequest(
  execCtx: ExecutionContext,
  request: AuthedRequest,
  principal: Extract<NonNullable<AuthedRequest["principal"]>, { kind: "session" }>,
): { tenantId: string; gateRequest: GateRequest } {
  const target = PATH_TENANT_HANDLERS.get(handlerKey(execCtx));
  const param = target?.kind === "path-tenant" ? target.param : "id";
  return {
    tenantId: String(request.params?.[param] ?? ""),
    gateRequest: {
      authSessionId: principal.sessionId,
      userId: principal.userId,
      method: request.method ?? "GET",
      route: routeTemplate(execCtx),
      requestId: assignRequestId(request, execCtx.switchToHttp().getResponse()),
    },
  };
}
