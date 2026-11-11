/**
 * PilotTenantsController: RT-1292 runtime of `platformAddPilotTenant` and
 * `platformRemovePilotTenant`, and RT-1328 `platformListPilotTenants`
 * (`pos-pilot-releases.openapi.yaml`):
 *
 *   GET    /api/v1/platform/pos-pilot-tenants
 *   PUT    /api/v1/platform/pos-pilot-tenants/{tenantId}
 *   DELETE /api/v1/platform/pos-pilot-tenants/{tenantId}
 *
 * Auth (as `platformSetPosVersionPolicy`, RT-327): `SessionOnlyAdminGuard`
 * (the human cookie session only; an unsafe request needs a trusted `Origin`,
 * RT-430), then `PlatformAdminGuard` (`users.is_platform_admin`, read from the
 * database; every other signed-in user is 403 `forbidden`). Platform scope: not
 * behind `TenantContextGuard`, no active tenant needed, no support session.
 * No `@Auditable`: an effective change writes its own platform-scoped row.
 *
 * A malformed tenant id is 400 `validation_error`; an unknown tenant is 404
 * `tenant_not_found`. Both operations are idempotent.
 */
import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  Param,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { PlatformAdminGuard } from "../audit/platform-admin.guard";
import type { AuthedRequest } from "../auth/auth.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { NoQuerySchema, TenantIdParamSchema } from "./dto";
import { PilotTenantNotFoundError, PilotTenantsService, type PilotTenantBody } from "./pilot-tenants.service";

/** The platform-admin routes that list, add and remove pilot allowlist tenants. */
@Controller("api/v1/platform/pos-pilot-tenants")
@UseGuards(SessionOnlyAdminGuard, PlatformAdminGuard)
export class PilotTenantsController {
  constructor(private readonly service: PilotTenantsService) {}

  /** GET: every allowlisted tenant, oldest first (RT-1328). */
  @Get()
  // RT-1328: platformListPilotTenants (read, not audited).
  @ConsoleRateLimit("cheapRead")
  @Header("Cache-Control", "no-store")
  async list(@Query(new ZodValidationPipe(NoQuerySchema)) _query: unknown): Promise<{ items: PilotTenantBody[] }> {
    return { items: await this.service.list() };
  }

  /** PUT: add the tenant to the allowlist (201 when added, 200 when already listed). */
  @Put(":tenantId")
  // RT-1292: platformAddPilotTenant (audited change).
  @ConsoleRateLimit("write")
  @Header("Cache-Control", "no-store")
  async add(
    @Req() request: AuthedRequest,
    @Param("tenantId", new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PilotTenantBody> {
    const principal = request.principal;
    if (principal?.kind !== "session") throw new UnauthorizedException("Unauthorized");
    try {
      const result = await this.service.add({ tenantId, actorUserId: principal.userId, requestId: request.requestId ?? null });
      res.status(result.created ? 201 : 200);
      return result.entry;
    } catch (err) {
      if (err instanceof PilotTenantNotFoundError) {
        throw new HttpException({ code: "tenant_not_found", message: "Tenant not found." }, 404);
      }
      throw err;
    }
  }

  /** DELETE: remove the tenant from the allowlist (204, also when it was not listed). */
  @Delete(":tenantId")
  @HttpCode(204)
  // RT-1292: platformRemovePilotTenant (audited change).
  @ConsoleRateLimit("write")
  async remove(
    @Req() request: AuthedRequest,
    @Param("tenantId", new ZodValidationPipe(TenantIdParamSchema)) tenantId: string,
  ): Promise<void> {
    const principal = request.principal;
    if (principal?.kind !== "session") throw new UnauthorizedException("Unauthorized");
    await this.service.remove({ tenantId, actorUserId: principal.userId, requestId: request.requestId ?? null });
  }
}
