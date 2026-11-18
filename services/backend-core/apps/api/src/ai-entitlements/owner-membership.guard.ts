/**
 * AiOwnerMembershipGuard — RT-664 (AD-AI-ENT-001 D-5): the opt-out write is
 * the tenant OWNER's, and since RT-1470 also a session platform admin's.
 *
 * RT-1470 (owner decision 2026-11-18, recorded on RT-1470): the platform admin
 * is the superior in this system, so a session platform admin may change a
 * tenant's opt-outs like its owner, member or not. A bearer token never
 * qualifies (RT-132 D6). The write stays subtract-only against the plan: an
 * opt-in never exceeds what the plan grants (422 `not_entitled`), so this is
 * no grant path. Everyone else still needs an active `owner` membership of the
 * session's tenant. It also refuses a `{tenant_id}` that is
 * a well-formed id of another tenant. Both refusals are the same
 * non-disclosing 404, raised before the idempotency interceptor stores a key
 * (contract check order step 1). A malformed `{tenant_id}` passes to the
 * handler's 400.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { PG_POOL } from "../database";
import { isSessionPlatformAdminContext } from "../context";
import { MembershipRepository } from "../context/membership.repository";
import type { ResolvedContext, TenantContextRequest } from "../context/types";
import { UUID_RE_I } from "../common/ids";

const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

type GuardRequest = TenantContextRequest & { params?: Record<string, string> };

function refuse(): never {
  throw new NotFoundException(NOT_FOUND);
}

/** The session's user and tenant, or null for anything but a session member context. */
function sessionMember(ctx: ResolvedContext | undefined): { userId: string; tenantId: string } | null {
  if (ctx?.source !== "session") return null;
  const { userId, tenantId } = ctx;
  return userId === null || tenantId === null ? null : { userId, tenantId };
}

/** A well-formed `{tenant_id}` of another tenant (a malformed one is the handler's 400). */
function namesAnotherTenant(request: GuardRequest, tenantId: string): boolean {
  const pathTenant = request.params?.["tenant_id"] ?? "";
  return UUID_RE_I.test(pathTenant) && pathTenant.toLowerCase() !== tenantId.toLowerCase();
}

@Injectable()
export class AiOwnerMembershipGuard implements CanActivate {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuardRequest>();
    const member = sessionMember(request.context) ?? refuse();
    if (namesAnotherTenant(request, member.tenantId)) refuse();
    if (isSessionPlatformAdminContext(request.context)) return true;
    const role = await runWithTenantContext(this.pool, { tenantId: member.tenantId, isPlatformAdmin: false }, (client) =>
      this.memberships.findRoleCodeForUserInTenant(member.userId, member.tenantId, client),
    );
    if (role !== "owner") refuse();
    return true;
  }
}
