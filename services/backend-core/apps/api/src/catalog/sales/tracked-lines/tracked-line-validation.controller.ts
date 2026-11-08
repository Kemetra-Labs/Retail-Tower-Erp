/**
 * TrackedLineValidationController — Jira RT-451 slice S2 (RT-50 F4; G7-5,
 * G7-8, Q11, Q12). Contract: `posValidateTrackedLine` in
 * `pos-sales/tracked-lines.yaml`.
 *
 *   POST /api/pos/v1/tracked-line-validations
 *
 * Guards, in order: `TrackedLineValidationAuthGuard` (the envelope, or the
 * device token with a live cashier claim; tenant, store and device come only
 * from the credential), then the per-device rate limit (ADR 0009; it fails
 * open). Then:
 *   - a malformed body is the 400 `validation_error` and writes nothing;
 *   - while the tracked-selling gate is off (the default) the answer is the
 *     contract's non-disclosing 404 and nothing is read or written;
 *   - while the tenant's switch (0086) is off, or the product does not resolve
 *     in the tenant, the same 404, nothing written;
 *   - otherwise a 200 with `accepted` or `refused` (a refusal is a business
 *     answer), and one validation record (0087) either way.
 *
 * No Idempotency-Key on purpose (the contract): every call re-evaluates the lot
 * and creates a new record. Audit: one `tracked_line.validated` change row per
 * answered request, naming the product, the outcome and reason, the validation
 * id and the device; never the lot code or the cashier claim.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { annotateAudit, Auditable } from "../../../audit/auditable.decorator";
import { PosWriteRateLimitBucket } from "../../../auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../../../auth/pos-write-rate-limit.guard";
import { DeviceBearer } from "../../../auth/route-auth";
import { ZodValidationPipe } from "../../../common/zod-validation.pipe";
import type { TenantContextRequest } from "../../../context/types";
import { TrackedLineValidationAuthGuard } from "./tracked-line-validation-auth.guard";
import { ValidateTrackedLineRequestSchema, type ValidateTrackedLineRequest } from "./tracked-line-validation.dto";
import { TrackedLineValidationService, type TrackedLineValidation } from "./tracked-line-validation.service";
import { isTrackedSellingEnabled } from "./tracked-selling-gate";

function notFound(): NotFoundException {
  return new NotFoundException("not_found");
}

@Controller()
export class TrackedLineValidationController {
  constructor(private readonly validations: TrackedLineValidationService) {}

  @Post("api/pos/v1/tracked-line-validations")
  @HttpCode(HttpStatus.OK)
  @DeviceBearer()
  @UseGuards(TrackedLineValidationAuthGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posValidateTrackedLine")
  @Auditable("tracked_line.validated")
  async validateTrackedLine(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(ValidateTrackedLineRequestSchema)) body: ValidateTrackedLineRequest,
  ): Promise<TrackedLineValidation> {
    const ctx = request.context;
    // The guard publishes all of them on both paths; fail closed (the generic 401) if it did not.
    if (!ctx?.tenantId || !ctx.storeId || !ctx.userId || !request.posDeviceId) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (!isTrackedSellingEnabled()) throw notFound();

    const { identity } = body;
    const result = await this.validations.validate({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deviceId: request.posDeviceId,
      // The envelope's operator, or the guard's VERIFIED cashier: never the raw claim.
      operatorUserId: ctx.userId,
      // The path the guard took, chosen by the same rule (the presence of `operatorUserId`).
      authPath: body.operatorUserId === undefined ? "envelope" : "device",
      productId: body.productId,
      identity:
        identity.identityId !== undefined
          ? { identityId: identity.identityId }
          : { code: identity.code!, ...(identity.expiryDate !== undefined ? { expiryDate: identity.expiryDate } : {}) },
      quantity: body.quantity,
      selection: body.selection,
      draftLineRef: body.draftLineRef,
    });
    if (result === null) throw notFound();
    annotateAudit(request, {
      product_id: body.productId,
      validation_id: result.validationId,
      outcome: result.outcome,
      ...(result.outcome === "refused" ? { reason: result.reason } : {}),
      device_id: request.posDeviceId,
    });
    return result;
  }
}
