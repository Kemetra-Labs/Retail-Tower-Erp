/**
 * SalesController — 008 US1 capture (T035).
 *
 * Implements the `captureSale` (+ `readSale`) operationIds from
 * `packages/contracts/openapi/pos-sales/sales.yaml`:
 *   POST /api/pos/v1/sales            → captureSale
 *   GET  /api/pos/v1/sales/{saleRef}  → readSale
 *
 * Auth / context: mirrors `posCaptureItem` — `@UseGuards(PosOperatorAuthGuard,
 * TenantContextGuard)` resolve the POS principal onto `req.context`; the
 * tenant/store/actor come from there and are NEVER read from the body
 * (FR-061). Body strictness (FR-062) is enforced by the `.strict()` Zod DTO.
 *
 * Idempotency: `@Idempotent("required")` engages the existing global
 * IdempotencyInterceptor (FR-051) — no new primitive. Provenance dedup
 * (FR-050) is enforced independently in the service, so a re-delivery with a
 * different Idempotency-Key still resolves to the same sale.
 *
 * Audit: `@Auditable("sale.captured")` is passive metadata read by the global
 * AuditEmitterInterceptor (FR-090). `readSale` emits one
 * `pos_sales.detail_read` per authorized 200 (RT-548, OD-534-7), metadata
 * `{ sale_ref }` only — no sale content.
 *
 * Status: 201 for a fresh capture; 200 with `Idempotent-Replayed: true` for a
 * provenance dedup-hit (deterministic, identical body — FR-100).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import type { Logger } from "@data-pulse-2/shared";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../audit/audit-job.enqueuer";
import { ROOT_LOGGER } from "../../common/logging.interceptor";
import { recordIdempotencyConflict } from "../../observability/metrics/api.metrics";

import { annotateAudit, Auditable } from "../../audit/auditable.decorator";
import { PosOperatorAuthGuard } from "../../auth/pos-operator-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../../auth/pos-write-rate-limit.guard";
import { PosWriteRateLimitBucket } from "../../auth/pos-write-rate-limit.decorator";
import { DeviceBearer, ReportsBuildIdentity } from "../../auth/route-auth";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import { type CaptureSaleRequestDto } from "./dto/capture-sale-request.dto";
import { CaptureSaleRequestPipe } from "./dto/capture-sale-request.pipe";
import {
  RecordVoidRequestSchema,
  type RecordVoidRequestDto,
} from "./dto/record-void-request.dto";
import {
  RecordRefundRequestSchema,
  type RecordRefundRequestDto,
} from "./dto/record-refund-request.dto";
import {
  RecordReturnRequestSchema,
  type RecordReturnRequestDto,
} from "./dto/record-return-request.dto";
import {
  RefundAllocationExceedsTenderError,
  RefundAllocationTenderInvalidError,
  RefundInstrumentNotAllowedError,
} from "./refund-allocation";
import { isLegacyRefundEnabled } from "./refund-gates";
import { isPosReturnsEnabled } from "./returns-gate";
import {
  VoidApprovalInvalidError,
  VoidApprovalRequiredError,
  VoidApproverNotEligibleError,
  VoidOutsideBusinessDayError,
  VoidRequesterMismatchError,
  VoidRequesterNotEligibleError,
  VoidSelfApprovalError,
} from "./void-approval";
import { SaleCaptureAuthGuard } from "./sale-capture-auth.guard";
import {
  SaleResponsibilityMismatchError,
  SaleResponsibilityOfflineRefusedError,
  SaleResponsibilityPayerInvalidError,
  SaleResponsibilityReplayConflictError,
  SaleResponsibilityRoleRefusedError,
} from "./sale-responsibilities";
import {
  SaleReturnsService,
  type SaleReturnProjection,
} from "./sale-returns.service";
import {
  CreditSaleReversalRestrictedError,
  ReturnLineInvalidError,
  ReturnOverReturnError,
  ReturnQuantityNotWholeError,
  ReturnTenderMismatchError,
  SaleAlreadyReversedError,
} from "./sale-reversal";
import {
  SalesService,
  SaleLinePricingInvalidError,
  SaleNotFoundError,
  SalePayloadReplayConflictError,
  SaleTenderMismatchError,
  SaleTenderReplayConflictError,
  SaleVoucherTenderInvalidError,
  TerminalEventProvenanceConflictError,
  type SaleProjection,
  type TerminalEventProjection,
} from "./sales.service";
import { UUID_RE_I } from "../../common/ids";

/** RT-1206: the capture route's `idempotency_conflict_total` label, as the interceptor forms it. */
const CAPTURE_SALE_ROUTE = "POST:/api/pos/v1/sales";
/** RT-1206: the audit action of a refused provenance replay with a different payload. */
const SALE_REPLAY_MISMATCH_AUDIT_ACTION = "sale.replay_payload_mismatch_rejected";

/**
 * Map a capture service error to its contract response (RT-77). The filter's
 * status fallback has no 422 case, so the code is passed explicitly.
 */
function toCaptureHttpError(err: unknown): unknown {
  const responsibility = toResponsibilityHttpError(err);
  if (responsibility !== null) return responsibility;
  if (err instanceof SaleTenderMismatchError) {
    return new UnprocessableEntityException({
      code: "sale_tender_mismatch",
      message: "tenders do not sum to posTotal",
    });
  }
  if (err instanceof SaleVoucherTenderInvalidError) {
    // RT-1114: one body for every cause (unknown, other store, reversed, used, amount).
    return new UnprocessableEntityException({
      code: "sale_voucher_tender_invalid",
      message: "a voucher tender does not reference a valid redemption",
    });
  }
  if (err instanceof SaleLinePricingInvalidError) {
    return new UnprocessableEntityException({
      code: "sale_line_pricing_invalid",
      message: "a sale line's price, amount or quantity breaks the price invariant",
    });
  }
  if (err instanceof SalePayloadReplayConflictError) {
    // RT-1206: the same 409 wire code, widened (sales.yaml `Conflict`) to a
    // provenance replay whose payload differs from the captured sale.
    return new ConflictException({
      code: "idempotency_key_conflict",
      message: "sale already captured with a different payload",
    });
  }
  if (err instanceof SaleTenderReplayConflictError) {
    // The contract's single 409 wire code (sales.yaml `Conflict`): the same
    // provenance reused with a different logical payload.
    return new ConflictException({
      code: "idempotency_key_conflict",
      message: "sale already captured with different tenders",
    });
  }
  return err;
}

/**
 * RT-418 (sales.yaml 1.10.0-draft `CaptureForbidden` / `CaptureUnprocessable`
 * / `Conflict`): the responsibility refusals, each one body for every cause;
 * null for any other error.
 */
function toResponsibilityHttpError(err: unknown): unknown {
  if (err instanceof SaleResponsibilityRoleRefusedError) {
    return new ForbiddenException({ code: "sale_responsibility_role_refused", message: err.message });
  }
  if (err instanceof SaleResponsibilityOfflineRefusedError) {
    return new UnprocessableEntityException({ code: "sale_responsibility_offline_refused", message: err.message });
  }
  if (err instanceof SaleResponsibilityMismatchError) {
    return new UnprocessableEntityException({ code: "sale_responsibility_mismatch", message: err.message });
  }
  if (err instanceof SaleResponsibilityPayerInvalidError) {
    return new UnprocessableEntityException({ code: "sale_responsibility_payer_invalid", message: err.message });
  }
  if (err instanceof SaleResponsibilityReplayConflictError) {
    return new ConflictException({ code: "idempotency_key_conflict", message: err.message });
  }
  return null;
}


/** RT-787: the RT-490 allocation refusals of `recordReturn` (`ReturnUnprocessable`, rule 1's 400). */
const ALLOCATION_REFUSALS: ReadonlyArray<readonly [new () => Error, 400 | 422, string]> = [
  [RefundAllocationTenderInvalidError, 400, "validation_error"],
  [RefundInstrumentNotAllowedError, 422, "refund_instrument_not_allowed"],
  [RefundAllocationExceedsTenderError, 422, "refund_allocation_exceeds_tender"],
];

/** Map a `recordReturn` service error: the allocation refusals, then every reversal error. */
function toReturnHttpError(err: unknown): unknown {
  for (const [type, status, code] of ALLOCATION_REFUSALS) {
    if (err instanceof type) {
      const body = { code, message: err.message };
      return status === 400 ? new BadRequestException(body) : new UnprocessableEntityException(body);
    }
  }
  return toReversalHttpError(err);
}

/**
 * Map a void / return service error to its contract response. Every code is
 * passed explicitly: the filter's status fallback has no 422 case.
 */
export function toReversalHttpError(err: unknown): unknown {
  if (err instanceof SaleNotFoundError) {
    // Cross-tenant / cross-store / unknown sale are indistinguishable.
    return new NotFoundException("not_found");
  }
  if (err instanceof TerminalEventProvenanceConflictError) {
    // Provenance reused for a different sale or payload → 409 (FR-013).
    return new ConflictException("conflict");
  }
  if (err instanceof CreditSaleReversalRestrictedError) {
    // RT-577: one body for every operator; nothing was recorded.
    return new ForbiddenException({ code: "credit_sale_reversal_restricted", message: err.message });
  }
  if (err instanceof SaleAlreadyReversedError) {
    return new ConflictException({ code: "already_reversed", message: "sale already reversed" });
  }
  if (err instanceof VoidApprovalRequiredError) {
    return new ForbiddenException({ code: "void_approval_required", message: err.message });
  }
  if (err instanceof VoidApprovalInvalidError) {
    return new UnprocessableEntityException({ code: "void_approval_invalid", message: err.message });
  }
  if (err instanceof VoidOutsideBusinessDayError) {
    return new UnprocessableEntityException({ code: "void_outside_business_day", message: err.message });
  }
  if (err instanceof VoidRequesterMismatchError) {
    return new ForbiddenException({ code: "void_requester_mismatch", message: err.message });
  }
  if (err instanceof VoidRequesterNotEligibleError) {
    return new ForbiddenException({ code: "void_requester_not_eligible", message: err.message });
  }
  if (err instanceof VoidSelfApprovalError) {
    return new ForbiddenException({ code: "void_self_approval", message: err.message });
  }
  if (err instanceof VoidApproverNotEligibleError) {
    return new ForbiddenException({ code: "void_approver_not_eligible", message: err.message });
  }
  if (err instanceof ReturnOverReturnError) {
    return new ConflictException({ code: "over_return", message: "return exceeds the returnable quantity" });
  }
  if (err instanceof ReturnTenderMismatchError) {
    return new UnprocessableEntityException({
      code: "return_tender_mismatch",
      message: "refund tenders do not match the return total",
    });
  }
  if (err instanceof ReturnLineInvalidError) {
    return new BadRequestException({ code: "validation_error", message: "lineRef is not a line of this sale" });
  }
  if (err instanceof ReturnQuantityNotWholeError) {
    return new BadRequestException({
      code: "validation_error",
      message: "quantity must be a whole number for a line sold in a whole quantity",
    });
  }
  return err;
}

@Controller()
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly saleReturnsService: SaleReturnsService,
    // RT-1206: the replay-mismatch audit. Optional so fixtures without
    // AuditModule still build; a missing enqueuer never changes the 409.
    @Optional() @Inject(AUDIT_JOB_ENQUEUER)
    private readonly auditEnqueuer: AuditJobEnqueuer | null = null,
    @Optional() @Inject(ROOT_LOGGER)
    private readonly logger: Logger | null = null,
  ) {}

  /**
   * RT-1206 (RT-148 owner ruling: "record the mismatch in audit/metrics"): the
   * platform `idempotency_conflict_total` counter and one ids-only audit event.
   * Emitted here, after the capture transaction has rolled back, so neither is
   * lost with it. Fire-and-forget: an audit failure never replaces the 409.
   */
  private recordReplayMismatch(request: TenantContextRequest, err: SalePayloadReplayConflictError): void {
    recordIdempotencyConflict({ route: CAPTURE_SALE_ROUTE });
    const ctx = request.context;
    const requestId = (request as { requestId?: string }).requestId ?? null;
    if (this.auditEnqueuer === null) {
      // Never silent: the ruling requires the audit, so a wiring gap is visible.
      this.logger?.warn(
        { component: "sales.capture", action: SALE_REPLAY_MISMATCH_AUDIT_ACTION, request_id: requestId },
        "SalesController: no audit enqueuer wired; replay-mismatch audit not recorded",
      );
      return;
    }
    this.auditEnqueuer
      .enqueue({
        actor_user_id: ctx?.userId ?? null,
        actor_label: null,
        tenant_id: ctx?.tenantId ?? null,
        store_id: ctx?.storeId ?? null,
        action: SALE_REPLAY_MISMATCH_AUDIT_ACTION,
        target_type: null,
        target_id: null,
        request_id: requestId,
        metadata: { sale_ref: err.saleId },
      })
      .catch((auditErr: unknown) => {
        this.logger?.error(
          {
            component: "sales.capture",
            action: SALE_REPLAY_MISMATCH_AUDIT_ACTION,
            request_id: requestId,
            err_class: auditErr instanceof Error ? auditErr.name : typeof auditErr,
          },
          "SalesController: replay-mismatch audit enqueue failed",
        );
      });
  }

  @Post("api/pos/v1/sales")
  // RT-224 (Option B): two alternative credentials. SaleCaptureAuthGuard runs
  // the unchanged envelope guard, or — when the body carries `operatorUserId`
  // — the device guard plus the cashier-admission check. @DeviceBearer makes
  // the global FailClosedAuthGuard defer to it (its opaque-token lookup would
  // reject a device token); both paths authenticate in the route guard.
  // Guard order matters: the auth guard runs FIRST (resolves request.principal
  // + the device), THEN the per-device rate limit (ADR 0009) throttles on that
  // device. The rate limit fails open on a Redis/lookup error, so it never
  // blocks a write the auth guard admitted.
  @DeviceBearer()
  @UseGuards(SaleCaptureAuthGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posWriteSale")
  @Idempotent("required")
  @Auditable("sale.captured")
  @ReportsBuildIdentity()
  async captureSale(
    @Req() request: TenantContextRequest,
    // RT-77: the schema is chosen per request by POS_SALE_TENDERS_ENABLED
    // (default off → the pre-RT-77 strict body, `tenders` is a 400).
    @Body(CaptureSaleRequestPipe)
    body: CaptureSaleRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SaleProjection> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // A POS sale MUST resolve a store binding (FR-001).
      throw new UnauthorizedException("store_context_required");
    }
    // RT-77 (RT-10 D7(i)): the guard's resolved device is the sale's device —
    // never a body field. A request the guard did not resolve to a device is
    // refused (the settlement-intent precedent).
    if (!request.posDeviceId) throw new UnauthorizedException("Unauthorized");

    // RT-224: `operatorUserId` is the device path's attribution CLAIM. The
    // guard verified it and published the cashier as ctx.userId, which is the
    // only actor recorded. The claim is not a sale fact, so it is dropped
    // before the service hashes the body into payload_hash.
    // RT-225: `admissionCheckAt` is only the guard's window instant, not a
    // sale fact either: dropped the same way, so payload_hash, the stored
    // occurred_at / business_date and the posting feed are unchanged. (Both
    // stay in the idempotency fingerprint, which covers the raw body.)
    // RT-539: `receipt` is presentation, not a sale fact (sales.yaml 1.9.0):
    // dropped from the hashed body and stored on its own, first write wins.
    // RT-451 S3: `safetyRevision` / `safetySyncedAt` are the till's safety
    // provenance (RT-50 G7-7), not sale facts: dropped from the hashed body
    // the same way and stored on their own, first write wins.
    const {
      operatorUserId: _attributionClaim,
      admissionCheckAt: _admissionCheckAt,
      receipt,
      safetyRevision,
      safetySyncedAt,
      ...saleBody
    } = body;
    const safety = {
      ...(safetyRevision === undefined ? {} : { safetyRevision }),
      ...(safetySyncedAt === undefined ? {} : { safetySyncedAt }),
    };

    let result;
    try {
      result = await this.salesService.captureSale({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        deviceId: request.posDeviceId,
        // RT-418: the path SaleCaptureAuthGuard took, chosen by the same rule
        // (the presence of `operatorUserId`); credit is envelope-only.
        authPath: _attributionClaim === undefined ? "envelope" : "device",
        body: saleBody,
        ...(receipt === undefined ? {} : { receipt }),
        safety,
      });
    } catch (err) {
      if (err instanceof SalePayloadReplayConflictError) this.recordReplayMismatch(request, err);
      throw toCaptureHttpError(err);
    }

    if (result.created) {
      res.status(HttpStatus.CREATED);
    } else {
      // Provenance dedup-hit: deterministic replay, identical body (FR-100).
      res.status(HttpStatus.OK);
      res.setHeader("Idempotent-Replayed", "true");
    }
    return result.projection;
  }

  @Get("api/pos/v1/sales/:saleRef")
  @UseGuards(PosOperatorAuthGuard, TenantContextGuard)
  @Auditable("pos_sales.detail_read")
  async readSale(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
  ): Promise<SaleProjection> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // Reads are store-scoped: a POS principal may only read sales captured
      // within its own store (spec §120/§449, FR-063). Mirrors captureSale.
      throw new UnauthorizedException("store_context_required");
    }
    if (!UUID_RE_I.test(saleRef)) {
      // Non-disclosing input guard: a malformed ref must not reach the DB (an
      // invalid uuid would surface as a 500). Treat it as a safe-404.
      throw new NotFoundException("not_found");
    }
    let projection: SaleProjection;
    try {
      projection = await this.salesService.readSaleProjection(
        ctx.tenantId,
        ctx.storeId,
        saleRef,
      );
    } catch (err) {
      if (err instanceof SaleNotFoundError) {
        // Non-disclosing 404 — cross-tenant / cross-store / absent are
        // indistinguishable (FR-063/102, SI-004).
        throw new NotFoundException("not_found");
      }
      throw err;
    }
    // RT-548: identifiers only (FR-AUDIT-3, §XIV) — never line/tender/payer
    // content. The interceptor emits only after a successful response.
    annotateAudit(request, { sale_ref: saleRef });
    return projection;
  }

  @Post("api/pos/v1/sales/:saleRef/void")
  @UseGuards(PosOperatorEnvelopeSaleGuard)
  @Idempotent("required")
  @Auditable("sale.voided")
  async recordVoid(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Body(new ZodValidationPipe(RecordVoidRequestSchema))
    body: RecordVoidRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TerminalEventProjection> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      throw new UnauthorizedException("store_context_required");
    }
    if (!UUID_RE_I.test(saleRef)) {
      // A malformed ref is a non-disclosing safe-404, never a 500 (SI-004).
      throw new NotFoundException("not_found");
    }
    try {
      const result = await this.salesService.recordVoid({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        saleRef,
        body,
      });
      if (result.created) {
        res.status(HttpStatus.CREATED);
      } else {
        // Provenance dedup-hit: deterministic replay, no duplicate (FR-013).
        res.status(HttpStatus.OK);
        res.setHeader("Idempotent-Replayed", "true");
      }
      // RT-530: the `sale.voided` audit event names the approver and approval.
      if (result.audit !== undefined) annotateAudit(request, { ...result.audit });
      return result.projection;
    } catch (err) {
      throw toReversalHttpError(err);
    }
  }

  /**
   * RT-73 line-aware return (RT-14 D1–D3). Behind the AC4 deployment gate:
   * until `POS_RETURNS_ENABLED` is on, the route answers 404 and records
   * nothing, so no `return` reversal reaches a Connector that predates RT-16.
   */
  @Post("api/pos/v1/sales/:saleRef/returns")
  @UseGuards(PosOperatorEnvelopeSaleGuard)
  @Idempotent("required")
  @Auditable("sale.returned")
  async recordReturn(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Body(new ZodValidationPipe(RecordReturnRequestSchema))
    body: RecordReturnRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SaleReturnProjection> {
    if (!isPosReturnsEnabled()) {
      throw new NotFoundException("not_found");
    }
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      throw new UnauthorizedException("store_context_required");
    }
    if (!UUID_RE_I.test(saleRef)) {
      throw new NotFoundException("not_found");
    }
    try {
      const result = await this.saleReturnsService.recordReturn({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        saleRef,
        body,
      });
      if (result.created) {
        res.status(HttpStatus.CREATED);
      } else {
        // Provenance replay: identical stored return, no duplicate (FR-013).
        res.status(HttpStatus.OK);
        res.setHeader("Idempotent-Replayed", "true");
      }
      return result.projection;
    } catch (err) {
      throw toReturnHttpError(err);
    }
  }

  @Post("api/pos/v1/sales/:saleRef/refund")
  @UseGuards(PosOperatorEnvelopeSaleGuard)
  @Idempotent("required")
  @Auditable("sale.refunded")
  async recordRefund(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Body(new ZodValidationPipe(RecordRefundRequestSchema))
    body: RecordRefundRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TerminalEventProjection> {
    // RT-787 (RT-271 R-11): gated off by default, a provenance replay included.
    if (!isLegacyRefundEnabled()) {
      throw new NotFoundException("not_found");
    }
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      throw new UnauthorizedException("store_context_required");
    }
    if (!UUID_RE_I.test(saleRef)) {
      throw new NotFoundException("not_found");
    }
    try {
      const result = await this.salesService.recordRefund({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        saleRef,
        body,
      });
      if (result.created) {
        res.status(HttpStatus.CREATED);
      } else {
        res.status(HttpStatus.OK);
        res.setHeader("Idempotent-Replayed", "true");
      }
      return result.projection;
    } catch (err) {
      if (err instanceof SaleNotFoundError) {
        throw new NotFoundException("not_found");
      }
      if (err instanceof TerminalEventProvenanceConflictError) {
        // Refund provenance reused for a different sale → 409 (FR-013).
        throw new ConflictException("conflict");
      }
      if (err instanceof CreditSaleReversalRestrictedError) {
        throw toReversalHttpError(err);
      }
      throw err;
    }
  }
}
