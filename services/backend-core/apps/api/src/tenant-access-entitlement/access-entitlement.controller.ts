/**
 * RT-1353 — the routes of `tenant-access-entitlement.openapi.yaml`:
 *
 *   GET  /api/v1/tenants/{tenant_id}/access-entitlement                              consoleGetTenantAccessEntitlement
 *   POST /api/v1/platform/tenants/{tenant_id}/access-entitlement/unlock-request      platformRequestTenantUnlock
 *   POST /api/v1/platform/tenants/{tenant_id}/access-entitlement/mark-provisioned    platformMarkTenantProvisioned
 *
 * Auth: the HUMAN `cookieAuth` session only (`SessionOnlyAdminGuard`; a bearer
 * is 401, a cookie POST without a trusted `Origin` is 403 `origin_rejected`).
 *   - The read adds `TenantContextGuard` and `RolesGuard` (`owner` /
 *     `tenant_admin` / `store_manager`, default deny → 404, as the AI
 *     entitlement read); `{tenant_id}` must be the session's tenant.
 *   - The two platform routes are not behind `TenantContextGuard` (a platform
 *     admin acts on any tenant): the service checks `users.is_platform_admin`
 *     (403 `forbidden`) and the tenant's existence (404), as the support
 *     sessions do. They write their audit row in the write's transaction, so
 *     neither carries `@Auditable`; the read is not audited as a change.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import type { AuthedRequest } from "../auth/auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import {
  AccessEntitlementService,
  type TenantAccessChangeBody,
  type TenantAccessEntitlementBody,
} from "./access-entitlement.service";

const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;
const UuidSchema = z.string().uuid();
const NoQuerySchema = z.object({}).strict();

function validated(tenantId: string): string {
  if (!UuidSchema.safeParse(tenantId).success) {
    throw new BadRequestException({ code: "validation_error", message: "tenant_id must be a valid UUID." });
  }
  return tenantId.toLowerCase();
}

@Controller("api/v1/tenants/:tenant_id/access-entitlement")
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard, RolesGuard)
@Roles("owner", "tenant_admin", "store_manager")
export class TenantAccessEntitlementConsoleController {
  constructor(private readonly service: AccessEntitlementService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  async read(
    @Req() request: TenantContextRequest,
    @Param("tenant_id") tenantId: string,
    @Query() query: unknown,
  ): Promise<TenantAccessEntitlementBody> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
    const id = validated(tenantId);
    if (id !== ctx.tenantId.toLowerCase()) throw new NotFoundException(NOT_FOUND);
    if (!NoQuerySchema.safeParse(query ?? {}).success) {
      throw new BadRequestException({ code: "validation_error", message: "No query parameter is accepted." });
    }
    return await this.service.read(ctx.tenantId);
  }
}

@Controller("api/v1/platform/tenants/:tenant_id/access-entitlement")
@UseGuards(SessionOnlyAdminGuard)
export class TenantAccessEntitlementPlatformController {
  constructor(private readonly service: AccessEntitlementService) {}

  @Post("unlock-request")
  @HttpCode(200)
  @ConsoleRateLimit("onboarding")
  @Header("Cache-Control", "no-store")
  async requestUnlock(@Req() request: AuthedRequest, @Param("tenant_id") tenantId: string): Promise<TenantAccessChangeBody> {
    return await this.service.requestUnlock({
      principal: request.principal,
      tenantId: validated(tenantId),
      requestId: request.requestId ?? null,
    });
  }

  @Post("mark-provisioned")
  @HttpCode(200)
  @ConsoleRateLimit("onboarding")
  @Header("Cache-Control", "no-store")
  async markProvisioned(@Req() request: AuthedRequest, @Param("tenant_id") tenantId: string): Promise<TenantAccessChangeBody> {
    return await this.service.markProvisioned({
      principal: request.principal,
      tenantId: validated(tenantId),
      requestId: request.requestId ?? null,
    });
  }
}
