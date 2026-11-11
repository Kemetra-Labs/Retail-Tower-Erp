/**
 * VouchersAdminController — RT-1108: the four operations of
 * `vouchers-admin.openapi.yaml` (RT-1101, RT-922 section 5.2):
 *
 *   POST /api/v1/vouchers                      consoleIssueVouchers
 *   GET  /api/v1/vouchers                      consoleListVouchers
 *   GET  /api/v1/vouchers/{voucher_id}         consoleGetVoucher
 *   POST /api/v1/vouchers/{voucher_id}/cancel  consoleCancelVoucher
 *
 * AUTH: the human cookie stack, in the contract's order: `DashboardAuthGuard`
 * (it carries the RT-430 Origin check on the two cookie POSTs), then
 * `TenantContextGuard`, then `RolesGuard` with owner / tenant_admin only (any
 * other role is 403 `forbidden`). The tenant is `request.context`, never a body
 * or query value.
 *
 * Issue is `@Idempotent("required", { replay: "forbid", replayMarkerFields:
 * ["batch_id"] })` (RT-82 K3): the 201 carries the one-time codes, so the
 * interceptor stores only a marker holding `batch_id`; a same-key retry is 409
 * `idempotency_key_conflict` and never issues or shows a code again. The
 * response is `Cache-Control: no-store`. Cancel is replayable.
 *
 * Voucher-domain refusals use the contract's closed codes (`validation_failure`,
 * `store_not_found`, `store_inactive`, `voucher_not_found`,
 * `voucher_already_redeemed`). A voucher or store that is not in scope is the
 * same non-disclosing 404.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
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

import { Auditable } from "../audit/auditable.decorator";
import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { Idempotent } from "../idempotency/idempotent.decorator";
import {
  ContractValidationPipe,
  VoucherIdParamSchema,
  VoucherIssueSchema,
  VoucherListQuerySchema,
  type VoucherBody,
  type VoucherCancelBody,
  type VoucherIssueBody,
  type VoucherIssueDto,
  type VoucherListQuery,
  type VoucherPageBody,
} from "./vouchers-admin.dto";
import { InvalidVoucherCursorError } from "./vouchers-admin.queries";
import { VoucherStoreInactiveError, VoucherStoreNotFoundError } from "./voucher-issue";
import { VoucherAlreadyRedeemedError, VoucherNotFoundError, VouchersAdminService } from "./vouchers-admin.service";

const STORE_NOT_FOUND = { code: "store_not_found", message: "A store was not found." } as const;
const VOUCHER_NOT_FOUND = { code: "voucher_not_found", message: "Voucher not found." } as const;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class VouchersAdminController {
  constructor(private readonly service: VouchersAdminService) {}

  @Post("api/v1/vouchers")
  @HttpCode(201)
  // The body carries the one-time codes: never cached.
  @Header("Cache-Control", "no-store")
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @Idempotent("required", { replay: "forbid", replayMarkerFields: ["batch_id"] })
  @ConsoleRateLimit("write")
  async issue(
    @Req() request: TenantContextRequest,
    @Body(new ContractValidationPipe(VoucherIssueSchema)) body: VoucherIssueDto,
  ): Promise<VoucherIssueBody> {
    const actor = actorOf(request);
    try {
      return await this.service.issue({ ...actor, body });
    } catch (err) {
      if (err instanceof VoucherStoreNotFoundError) throw new NotFoundException(STORE_NOT_FOUND);
      if (err instanceof VoucherStoreInactiveError) {
        throw new ConflictException({ code: "store_inactive", message: "An eligible store is inactive." });
      }
      throw err;
    }
  }

  @Get("api/v1/vouchers")
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @Auditable("vouchers.listed")
  @ConsoleRateLimit("cheapRead")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ContractValidationPipe(VoucherListQuerySchema)) query: VoucherListQuery,
  ): Promise<VoucherPageBody> {
    try {
      return await this.service.list({ tenantId: actorOf(request).tenantId, query });
    } catch (err) {
      if (err instanceof InvalidVoucherCursorError) {
        throw new BadRequestException({ code: "validation_failure", message: "cursor is not valid." });
      }
      throw err;
    }
  }

  @Get("api/v1/vouchers/:voucher_id")
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @Auditable("vouchers.read")
  @ConsoleRateLimit("cheapRead")
  async get(
    @Req() request: TenantContextRequest,
    @Param("voucher_id", new ContractValidationPipe(VoucherIdParamSchema)) voucherId: string,
  ): Promise<VoucherBody> {
    try {
      return await this.service.get({ tenantId: actorOf(request).tenantId, voucherId });
    } catch (err) {
      if (err instanceof VoucherNotFoundError) throw new NotFoundException(VOUCHER_NOT_FOUND);
      throw err;
    }
  }

  @Post("api/v1/vouchers/:voucher_id/cancel")
  @HttpCode(200)
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @Idempotent("required")
  @ConsoleRateLimit("write")
  async cancel(
    @Req() request: TenantContextRequest,
    @Param("voucher_id", new ContractValidationPipe(VoucherIdParamSchema)) voucherId: string,
  ): Promise<VoucherCancelBody> {
    try {
      return await this.service.cancel({ ...actorOf(request), voucherId });
    } catch (err) {
      if (err instanceof VoucherNotFoundError) throw new NotFoundException(VOUCHER_NOT_FOUND);
      if (err instanceof VoucherAlreadyRedeemedError) {
        throw new ConflictException({ code: "voucher_already_redeemed", message: "The voucher was already redeemed." });
      }
      throw err;
    }
  }
}

interface Actor {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

/** The session's tenant and user. Both are always set behind the cookie guards; anything else is a 401. */
function actorOf(request: TenantContextRequest): Actor {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null || ctx.userId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, actorUserId: ctx.userId, requestId: request.requestId ?? null };
}
