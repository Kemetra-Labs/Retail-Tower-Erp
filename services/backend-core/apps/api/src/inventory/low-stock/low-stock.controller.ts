/**
 * ConsoleLowStockController — RT-1069: the runtime of the console low-stock
 * read (`inventory/low-stock.yaml`, RT-1055 LS-1 to LS-5; thresholds per
 * RT-1064 TH-3) for the Admin-Console Overview «low stock» column.
 *
 *   GET /api/v1/inventory/low-stock  consoleListLowStock
 *
 * Auth (LS-4): the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard`
 * (every bearer is 401), `TenantContextGuard`, then `RolesGuard` +
 * `@Roles("owner", "tenant_admin", "store_manager")` (default deny → the
 * non-disclosing 404). The guards run before the query is validated, so a
 * refused role is a 404 for any input. The store scope is applied by the
 * service; a `store_id` outside it, of another tenant or soft-deleted is the
 * same 404. There is no 403.
 *
 * Refusals: a malformed, repeated or unknown query key is 400
 * `validation_error` (the pipe). Not audited: an inventory read with no money
 * figure, as `getOnHand` and `listInventorySafetyFindings`. Every 200 is
 * `Cache-Control: no-store`. Console rate-limit class `expensiveRead`
 * (`classes/inventory/low-stock.rate-limit.yaml`).
 */
import { Controller, Get, Header, NotFoundException, Query, Req, UnauthorizedException, UseGuards } from "@nestjs/common";

import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { ConsoleLowStockQuerySchema, LOW_STOCK_LIMIT_DEFAULT, type ConsoleLowStockQuery } from "./low-stock.query";
import { ConsoleLowStockService, LowStockNotFoundError, type ConsoleLowStockList } from "./low-stock.service";

/** The one 404 body of this surface, equal to the `RolesGuard` refusal (FR-ISO-4). */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConsoleLowStockController {
  constructor(private readonly service: ConsoleLowStockService) {}

  @Get("api/v1/inventory/low-stock")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  // RT-1055: a compute-on-read on-hand sum over every evaluated (store, product) pair of the scope, then a sort.
  @ConsoleRateLimit("expensiveRead")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ConsoleLowStockQuerySchema)) query: ConsoleLowStockQuery,
  ): Promise<ConsoleLowStockList> {
    const ctx = request.context;
    if (ctx === undefined || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
    try {
      return await this.service.list({
        tenantId: ctx.tenantId,
        context: ctx,
        storeId: query.store_id ?? null,
        limit: query.limit ?? LOW_STOCK_LIMIT_DEFAULT,
      });
    } catch (err) {
      if (err instanceof LowStockNotFoundError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }
}
