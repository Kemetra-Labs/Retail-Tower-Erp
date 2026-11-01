/**
 * ConsoleSalesByStoreController — RT-1053: the console sales by store
 * (`console-sales-by-store.openapi.yaml`, RT-1008) for the Admin-Console
 * «Sales by store» report.
 *
 *   GET /api/v1/sales-by-store  consoleGetSalesByStore
 *
 * Auth: the `console-sales` chain. The HUMAN `cookieAuth` session only →
 * `SessionOnlyAdminGuard` (every bearer is 401), `TenantContextGuard`, then
 * `RolesGuard` + `@Roles("owner", "tenant_admin", "store_manager")` (default
 * deny → 404). The guards run before the query is validated, so a refused
 * role is a 404 for any input. The store scope is applied by the service.
 *
 * Refusals: a malformed query is 400 `validation_error`; a scope of more
 * than 500 stores is 400 `scope_too_large`; a role outside the list is the
 * non-disclosing 404 of `console-sales`.
 *
 * Audit: one `console_sales.by_store_read` per 200, emitted by the request
 * audit interceptor. Metadata (`annotateAudit`): the range, the ranking
 * currency, `compare` and the number of stores returned; never a figure, a
 * rank or a store name.
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

import { annotateAudit, Auditable } from "../audit/auditable.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import type { ConsoleSalesByStore } from "./console-sales-by-store.projections";
import {
  ConsoleSalesByStoreQuerySchema,
  ScopeTooLargeError,
  type ConsoleSalesByStoreQuery,
} from "./console-sales-by-store.query";
import { ConsoleSalesByStoreService } from "./console-sales-by-store.service";

/** The `console_sales.by_store_read` metadata: never a figure, a rank or a name. */
export function byStoreAuditOf(query: ConsoleSalesByStoreQuery, storeCount: number): Record<string, unknown> {
  return {
    from: query.from,
    to: query.to,
    currency: query.currency,
    compare: query.compare,
    store_count: storeCount,
  };
}

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConsoleSalesByStoreController {
  constructor(private readonly service: ConsoleSalesByStoreService) {}

  /** GET — every store of the caller's scope, ranked in one currency. */
  @Get("api/v1/sales-by-store")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("console_sales.by_store_read")
  @Header("Cache-Control", "no-store")
  // RT-1008: an aggregate and ranking over up to 31 business days (plus the baseline) of up to 500 stores.
  @ConsoleRateLimit("expensiveRead")
  async byStore(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ConsoleSalesByStoreQuerySchema)) query: ConsoleSalesByStoreQuery,
  ): Promise<ConsoleSalesByStore> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
    let body: ConsoleSalesByStore;
    try {
      body = await this.service.byStore({
        tenantId: ctx.tenantId,
        context: ctx,
        from: query.from,
        to: query.to,
        currency: query.currency,
        compare: query.compare,
      });
    } catch (err) {
      if (err instanceof ScopeTooLargeError) {
        throw new BadRequestException({ code: "scope_too_large", message: err.message });
      }
      throw err;
    }
    annotateAudit(request, byStoreAuditOf(query, body.stores.length));
    return body;
  }
}
