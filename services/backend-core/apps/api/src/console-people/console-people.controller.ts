/**
 * ConsolePeopleController — RT-1063: the console people-name read
 * (`console-people.openapi.yaml`, RT-968) that turns `users.id` references
 * on Console history surfaces into display names.
 *
 *   GET /api/v1/console/people  listPeopleNames
 *
 * Auth: the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard` (every
 * bearer is 401), `TenantContextGuard`, then `RolesGuard` +
 * `@Roles("owner", "tenant_admin", "store_manager")` (default deny → 404).
 * The guards run before the query is validated, so a refused role is a 404
 * for any input. The tenant is the session's; there is no tenant parameter.
 *
 * Refusals: a malformed `ids` (missing, repeated, empty, too long, more than
 * 200, not a UUID) or any other query key is 400 `validation_error`.
 *
 * Audit: one `people.names_read` per 200, emitted by the request audit
 * interceptor. Metadata (`annotateAudit`): `requested_count` (distinct ids
 * asked) and `resolved_count` (items returned); never an id or a name.
 */
import { Controller, Get, Header, Query, Req, UnauthorizedException, UseGuards } from "@nestjs/common";

import { annotateAudit, Auditable } from "../audit/auditable.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { ListPeopleNamesQuerySchema, type ListPeopleNamesQuery } from "./console-people.query";
import { ConsolePeopleService, type PeopleNames } from "./console-people.service";

/** The `people.names_read` metadata: counts only, never an id or a name. */
export function peopleNamesAuditOf(requestedCount: number, resolvedCount: number): Record<string, unknown> {
  return { requested_count: requestedCount, resolved_count: resolvedCount };
}

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConsolePeopleController {
  constructor(private readonly service: ConsolePeopleService) {}

  /** GET — the display names of the resolvable ids among `ids`. */
  @Get("api/v1/console/people")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("people.names_read")
  @Header("Cache-Control", "no-store")
  // RT-968 D-4: one indexed lookup bounded at 200 ids; the class of listMembers.
  @ConsoleRateLimit("cheapRead")
  async listPeopleNames(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListPeopleNamesQuerySchema)) query: ListPeopleNamesQuery,
  ): Promise<PeopleNames> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
    const body = await this.service.listNames({ tenantId: ctx.tenantId, context: ctx, ids: query.ids });
    annotateAudit(request, peopleNamesAuditOf(query.ids.length, body.items.length));
    return body;
  }
}
