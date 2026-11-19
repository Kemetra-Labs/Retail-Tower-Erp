/**
 * SaleQuarantineOpsController — RT-1312 Phase 3(b), slice B: the Console half
 * of the sale quarantine (`sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft),
 * under the same `/api/v1/catalog/sale-sync-ops` namespace as the NEEDS_REPAIR
 * surface:
 *
 *   GET  /quarantined-sales                           consoleListQuarantinedSales
 *   GET  /quarantined-sales/{quarantineRef}           consoleGetQuarantinedSale
 *   POST /quarantined-sales/{quarantineRef}/write-off consoleWriteOffQuarantinedSale
 *
 * `consoleRepairQuarantinedSale` is slice C and has no route here.
 *
 * Authenticated by the HUMAN `cookieAuth` -> `DashboardAuthGuard`, then
 * `TenantContextGuard` (publishes `request.context`); `RolesGuard` + `@Roles`
 * gate every route to `owner` and `tenant_admin` (decision C1). `tenant_id`
 * resolves server-side from `request.context`, never the query or body
 * (§XII). Every response is a `QuarantinedSale` projection: no raw entity, no
 * stored body (§IV, decision C5). The caller's membership store scope (RT-193)
 * bounds every read and the write-off in the service; an item or `store_id`
 * outside it is the same non-disclosing 404.
 *
 * The write-off is the only write: audited (`@Auditable`, with ids only in the
 * audit metadata, never the free-text note), `Idempotency-Key` required.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { annotateAudit, Auditable } from "../../audit/auditable.decorator";
import { DashboardAuthGuard } from "../../auth/dashboard-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  QuarantineListQuerySchema,
  QuarantineRefSchema,
  QuarantineWriteOffBodySchema,
  type QuarantineListQuery,
  type QuarantineWriteOffBody,
} from "./dto/sale-quarantine-ops.dto";
import {
  QuarantineNotFoundError,
  SaleQuarantineOpsService,
  type QuarantinedSaleBody,
} from "./sale-quarantine-ops.service";
import {
  RepairConflictError,
  SaleSyncOpsReadModelService,
  StoreNotInScopeError,
  type Page,
  type ScopedReadInput,
} from "./sale-sync-ops.read-model.service";

const BASE = "api/v1/catalog/sale-sync-ops/quarantined-sales";

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class SaleQuarantineOpsController {
  constructor(
    private readonly service: SaleQuarantineOpsService,
    private readonly readModel: SaleSyncOpsReadModelService,
  ) {}

  /** GET — the quarantined sales of one state (default `open`), newest-first, keyset paginated. */
  @Get(BASE)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("sale_sync_ops.quarantine.listed")
  // RT-1312 Phase 3(b) (RT-574 D3): consoleListQuarantinedSales.
  @ConsoleRateLimit("expensiveRead")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(QuarantineListQuerySchema)) query: QuarantineListQuery,
  ): Promise<Page<QuarantinedSaleBody>> {
    const scoped = sessionScope(request);
    const storeFilter = query.store_id ? { storeId: query.store_id } : {};
    await settle(() => this.readModel.assertStoreInScope({ ...scoped, ...storeFilter }));
    return this.service.list({
      ...scoped,
      ...storeFilter,
      cursor: query.cursor ?? null,
      limit: query.page_size ?? 50,
      ...(query.state ? { state: query.state } : {}),
    });
  }

  /** GET — one quarantined sale, any state. */
  @Get(`${BASE}/:quarantineRef`)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("sale_sync_ops.quarantine.read")
  // RT-1312 Phase 3(b) (RT-574 D3): consoleGetQuarantinedSale.
  @ConsoleRateLimit("cheapRead")
  async get(
    @Req() request: TenantContextRequest,
    @Param("quarantineRef") quarantineRef: string,
  ): Promise<QuarantinedSaleBody> {
    const scoped = sessionScope(request);
    assertRef(quarantineRef);
    return await settle(() => this.service.get(scoped, quarantineRef));
  }

  /** POST — close an open item without a sale (decision C3). */
  @Post(`${BASE}/:quarantineRef/write-off`)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  @Auditable("sale_sync_ops.quarantine.written_off")
  // RT-1312 Phase 3(b) (RT-574 D3): consoleWriteOffQuarantinedSale.
  @ConsoleRateLimit("write")
  async writeOff(
    @Req() request: TenantContextRequest,
    @Param("quarantineRef") quarantineRef: string,
    @Body(new ZodValidationPipe(QuarantineWriteOffBodySchema)) body: QuarantineWriteOffBody,
  ): Promise<QuarantinedSaleBody> {
    const scoped = sessionScope(request);
    assertRef(quarantineRef);
    const item = await settle(() => this.service.writeOff(scoped, quarantineRef, body.note));
    // Ids and the new state only: the note is operator free text (FR-AUDIT-3, §XIV).
    annotateAudit(request, { quarantine_ref: item.quarantineRef, store_id: item.storeId, state: item.state });
    return item;
  }
}

/** The tenant + the session context whose store scope bounds the read / write-off (RT-193). */
function sessionScope(request: TenantContextRequest): ScopedReadInput {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}

/**
 * A syntactically MALFORMED ref is a 400 `validation_error` BEFORE any DB hit
 * (a request-shape error, discloses nothing); a VALID ref that does not
 * resolve in scope is the service's non-disclosing 404.
 */
function assertRef(quarantineRef: string): void {
  if (!QuarantineRefSchema.safeParse(quarantineRef).success) {
    throw new BadRequestException({ code: "validation_error", message: "quarantineRef must be a valid UUID." });
  }
}

/** Run `fn`, answering a service error with its HTTP error; anything unexpected passes through (the global filter answers 500). */
function settle<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    throw httpErrorOf(err);
  });
}

function httpErrorOf(err: unknown): unknown {
  if (err instanceof QuarantineNotFoundError || err instanceof StoreNotInScopeError) {
    return new NotFoundException({ code: "not_found", message: "Not found." });
  }
  if (err instanceof RepairConflictError) {
    // The item is not `open`: DISTINCT from the live POS provenance 409 (F-3).
    return new ConflictException({ code: "repair_conflict", message: "The quarantined sale is not open." });
  }
  return err;
}
