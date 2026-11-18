/**
 * The cross-tenant audit row for an unsafe request that RT-430 refused for its
 * `Origin`.
 *
 * `AuthGuard` checks `Origin` before any tenant logic runs, so on a covered
 * route a platform admin would otherwise leave no
 * `platform.cross_tenant.accessed` row. Since RT-1468 every platform-admin
 * request on a covered route is recorded, member or not, so this records the
 * refused one too: `support_session_required` when the tenant does not exist,
 * else `origin_rejected`.
 *
 * Returns null when it does not apply (the route is not covered, or the user
 * is not a platform admin): the caller then throws the plain RT-430 refusal and
 * writes no row. Reads only: the auth session's idle window is never slid by a
 * refused request.
 */
import type { ExecutionContext, ForbiddenException } from "@nestjs/common";
import type { Pool } from "pg";

import { coveredTarget, routeTemplate } from "./support-session.coverage";
import { SupportSessionGate, type GateRequest } from "./support-session.gate";
import { withSupportSessionCtx } from "./support-session.lifecycle";

export interface OriginRefusalInput {
  readonly execCtx: ExecutionContext;
  readonly authSessionId: string;
  readonly userId: string;
  readonly activeTenantId: string | null;
  readonly method: string;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly requestId: string | null;
}

export async function auditSupportSessionOriginRefusal(
  pool: Pool,
  input: OriginRefusalInput,
): Promise<ForbiddenException | null> {
  const target = coveredTarget(input.execCtx);
  if (!target) return null;
  const tenantId =
    target.kind === "path-tenant" ? String(input.params[target.param] ?? "") : input.activeTenantId;
  if (tenantId === null) return null;
  if (!(await isPlatformAdmin(pool, input.userId))) return null;

  const gate = new SupportSessionGate(pool);
  const request: GateRequest = {
    authSessionId: input.authSessionId,
    userId: input.userId,
    method: input.method,
    route: routeTemplate(input.execCtx),
    requestId: input.requestId,
  };
  if (!(await gate.tenantRowExists(tenantId))) {
    return gate.refuseUnresolvable(request).catch((error_: ForbiddenException) => error_);
  }
  return gate.recordOriginRefusal(tenantId, request);
}

async function isPlatformAdmin(pool: Pool, userId: string): Promise<boolean> {
  return await withSupportSessionCtx(pool, async (client) => {
    const { rows } = await client.query<{ is_platform_admin: boolean }>(
      `SELECT is_platform_admin FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    return rows[0]?.is_platform_admin === true;
  });
}
