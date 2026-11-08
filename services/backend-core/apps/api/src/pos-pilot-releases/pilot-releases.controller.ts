/**
 * PilotReleasesController: RT-1292 runtime of `consolePilotGetLatestPosRelease`
 * (`packages/contracts/openapi/pos-pilot-releases.openapi.yaml`):
 *
 *   GET /api/v1/pos-pilot-releases/latest
 *
 * Auth: the guard chain of the pairing-code routes. The HUMAN `cookieAuth`
 * session only (`SessionOnlyAdminGuard`: any bearer, device token or operator
 * envelope is 401), `TenantContextGuard` (a session with no active tenant is
 * 401; a platform admin without a membership or a live support session is 403),
 * then `RolesGuard` + owner / tenant_admin / store_manager (default deny → the
 * non-disclosing 404). The tenant is the session's, never the request's.
 *
 * The route takes no query parameter: any key is 400 `validation_error`,
 * raised after the guards and before any read. The reply is `Cache-Control:
 * no-store` (it may carry a presigned URL). The audit row of an issued link is
 * written by the service; no `@Auditable` here, because only an issued link is
 * audited.
 */
import { Controller, Get, Header, Query, Req, UnauthorizedException, UseGuards } from "@nestjs/common";

import { NoQuerySchema } from "./dto";
import type { LatestPilotRelease } from "./pilot-release.resolver";
import { PilotReleaseService } from "./pilot-release.service";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class PilotReleasesController {
  constructor(private readonly service: PilotReleaseService) {}

  /** GET: the current pilot release and a short-lived download URL, or `{ available: false }`. */
  @Get("api/v1/pos-pilot-releases/latest")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  // RT-1292: consolePilotGetLatestPosRelease (issues a link, writes an audit row).
  @ConsoleRateLimit("write")
  @Header("Cache-Control", "no-store")
  async latest(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(NoQuerySchema)) _query: unknown,
  ): Promise<LatestPilotRelease> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
    return await this.service.latest({ tenantId: ctx.tenantId, context: ctx, requestId: request.requestId ?? null });
  }
}
