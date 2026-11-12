/**
 * RT-1138: the routes of `cashier-suspensions.openapi.yaml`.
 *
 *   GET    /api/v1/stores/{store_id}/cashier-suspensions                      consoleListCashierSuspensions
 *   PUT    /api/v1/stores/{store_id}/cashiers/{user_id}/suspension            consoleSuspendCashier
 *   DELETE /api/v1/stores/{store_id}/cashiers/{user_id}/suspension            consoleReactivateCashier
 *
 * Auth: the HUMAN `cookieAuth` session only (`SessionOnlyAdminGuard`; a bearer
 * is 401, a cookie write without a trusted `Origin` is 403 `origin_rejected`).
 * `TenantContextGuard` resolves the active tenant, so the tenant is NEVER a
 * parameter (§XII). The two writes need `owner` or `tenant_admin`; the list
 * also allows `store_manager` (the Console page reads it). Default deny is 404.
 * Both writes write their audit row in the write's transaction, so neither
 * carries `@Auditable`.
 */
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { ResolvedContext, TenantContextRequest } from "../context/types";
import {
  CashierSuspensionsService,
  type CashierSuspensionChangeBody,
  type CashierSuspensionListBody,
} from "./cashier-suspensions.service";

const UuidSchema = z.string().uuid();
const NoQuerySchema = z.object({}).strict();

function uuid(value: string, name: string): string {
  if (!UuidSchema.safeParse(value).success) {
    throw new BadRequestException({ code: "validation_error", message: `${name} must be a valid UUID.` });
  }
  return value.toLowerCase();
}

/** The resolved context; a null tenant (a platform admin with no active tenant) is the service's non-disclosing 404. */
function contextOf(request: TenantContextRequest): ResolvedContext {
  const ctx = request.context;
  if (!ctx) throw new UnauthorizedException("Unauthorized");
  return ctx;
}

@Controller("api/v1/stores/:store_id")
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard, RolesGuard)
export class CashierSuspensionsController {
  constructor(private readonly service: CashierSuspensionsService) {}

  @Get("cashier-suspensions")
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  async list(
    @Req() request: TenantContextRequest,
    @Param("store_id") storeId: string,
    @Query() query: unknown,
  ): Promise<CashierSuspensionListBody> {
    const ctx = contextOf(request);
    if (!NoQuerySchema.safeParse(query ?? {}).success) {
      throw new BadRequestException({ code: "validation_error", message: "No query parameter is accepted." });
    }
    return await this.service.list(ctx, uuid(storeId, "store_id"));
  }

  @Put("cashiers/:user_id/suspension")
  @HttpCode(200)
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @ConsoleRateLimit("incidentControl")
  @Header("Cache-Control", "no-store")
  async suspend(
    @Req() request: TenantContextRequest,
    @Param("store_id") storeId: string,
    @Param("user_id") userId: string,
  ): Promise<CashierSuspensionChangeBody> {
    return await this.service.suspend({
      ctx: contextOf(request),
      storeId: uuid(storeId, "store_id"),
      userId: uuid(userId, "user_id"),
      requestId: request.requestId ?? null,
    });
  }

  @Delete("cashiers/:user_id/suspension")
  @HttpCode(200)
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @ConsoleRateLimit("incidentControl")
  @Header("Cache-Control", "no-store")
  async reactivate(
    @Req() request: TenantContextRequest,
    @Param("store_id") storeId: string,
    @Param("user_id") userId: string,
  ): Promise<CashierSuspensionChangeBody> {
    return await this.service.reactivate({
      ctx: contextOf(request),
      storeId: uuid(storeId, "store_id"),
      userId: uuid(userId, "user_id"),
      requestId: request.requestId ?? null,
    });
  }
}
