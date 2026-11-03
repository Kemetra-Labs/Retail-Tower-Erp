/**
 * TrackedLotsController — Jira RT-451 slice S1 (RT-50 F4; G7-5, G7-13, Q10,
 * Q12). Contract: `posListTrackedLots` in `pos-sales/tracked-lines.yaml`.
 *
 *   GET /api/pos/v1/products/{productId}/tracked-lots
 *
 * Guards, in order: `TrackedLotsAuthGuard` (the envelope, or the device token
 * alone; tenant and store come only from the credential), then the per-device
 * rate limit (ADR 0009; it fails open). Then:
 *   - a malformed `productId` is the 400 `validation_error`;
 *   - while the tracked-selling gate is off (the default) the answer is the
 *     contract's non-disclosing 404 and nothing is read;
 *   - a product that does not resolve in the tenant is the same 404.
 *
 * Audit: one `tracked_lots.listed` read row per answered request, naming the
 * device on the device path and the product; never the lots.
 */
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { annotateAudit, Auditable } from "../../../audit/auditable.decorator";
import { PosWriteRateLimitBucket } from "../../../auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../../../auth/pos-write-rate-limit.guard";
import { DeviceBearer } from "../../../auth/route-auth";
import { ZodValidationPipe } from "../../../common/zod-validation.pipe";
import type { TenantContextRequest } from "../../../context/types";
import { TrackedLotsAuthGuard } from "./tracked-lots-auth.guard";
import { TrackedLotsService, type TrackedLotList } from "./tracked-lots.service";
import { isTrackedSellingEnabled } from "./tracked-selling-gate";

const ProductIdSchema = z.string().uuid();

function notFound(): NotFoundException {
  return new NotFoundException("not_found");
}

@Controller()
export class TrackedLotsController {
  constructor(private readonly lots: TrackedLotsService) {}

  @Get("api/pos/v1/products/:productId/tracked-lots")
  @DeviceBearer()
  @UseGuards(TrackedLotsAuthGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posReadTrackedLots")
  @Auditable("tracked_lots.listed")
  async listTrackedLots(
    @Req() request: TenantContextRequest,
    @Param("productId", new ZodValidationPipe(ProductIdSchema)) productId: string,
  ): Promise<TrackedLotList> {
    const ctx = request.context;
    // The guard publishes both; fail closed (the generic 401) if it did not.
    if (!ctx?.tenantId || !ctx.storeId) throw new UnauthorizedException("Unauthorized");
    if (!isTrackedSellingEnabled()) throw notFound();

    const list = await this.lots.listLots({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId });
    if (list === null) throw notFound();
    annotateAudit(request, {
      product_id: productId,
      lot_count: list.lots.length,
      ...(request.posDeviceId !== undefined ? { device_id: request.posDeviceId } : {}),
    });
    return list;
  }
}
