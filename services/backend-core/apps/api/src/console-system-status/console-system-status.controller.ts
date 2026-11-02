/**
 * ConsoleSystemStatusController — RT-1062: the console system status
 * (`console-system-status.openapi.yaml`, RT-1056) for the Admin-Console
 * sidebar status block.
 *
 *   GET /api/v1/system-status  consoleGetSystemStatus
 *
 * Auth (D-3): the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard`
 * (every bearer is 401), `TenantContextGuard`, then `RolesGuard` +
 * `@Roles("owner", "tenant_admin")` (default deny → the non-disclosing 404).
 * The guards run before the query check, so a refused role is a 404 for any
 * input. Tenant-wide; no `store_id`.
 *
 * Refusals: any query key is 400 `validation_error` (the operation takes
 * none).
 *
 * Freshness (D-2): computed on every read, `Cache-Control: no-store`.
 * Read budget (D-4): console rate-limit class `cheapRead`; not audited.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import type { ConsoleSystemStatus } from "./console-system-status.projections";
import { ConsoleSystemStatusService } from "./console-system-status.service";

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConsoleSystemStatusController {
  constructor(private readonly service: ConsoleSystemStatusService) {}

  /** GET — the tenant's server, sale sync queue and ERPNext connector states. */
  @Get("api/v1/system-status")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Header("Cache-Control", "no-store")
  // RT-1056 D-4: a few bounded tenant-scoped checks, read on shell load and on Refresh only (no polling).
  @ConsoleRateLimit("cheapRead")
  async systemStatus(
    @Req() request: TenantContextRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<ConsoleSystemStatus> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
    if (Object.keys(query ?? {}).length > 0) {
      throw new BadRequestException({ code: "validation_error", message: "No query parameter is accepted." });
    }
    return this.service.read({ tenantId: ctx.tenantId });
  }
}
