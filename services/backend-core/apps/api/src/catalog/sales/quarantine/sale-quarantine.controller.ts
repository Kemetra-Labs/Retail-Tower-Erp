/**
 * SaleQuarantineController: RT-1312 Phase 3(b) runtime of `posQuarantineSale`
 * (`packages/contracts/openapi/pos-sales/sale-quarantine.yaml` 1.0.0-draft):
 *
 *   POST /api/pos/v1/quarantined-sales
 *
 * Auth: the role-named `device` scheme only: `@DeviceBearer()` +
 * `PosDeviceAuthGuard`. Tenant, store and device come from the device row the
 * guard resolved, never from the body. Then the per-device write budget of its
 * own bucket (decision P6, ADR 0009), so an upload backlog never slows live
 * capture. The body limit is 256 kB, and a larger-than-default body is read
 * only after the device guard passed on its headers (decision P5;
 * `common/json-body-limits.ts`, `auth/device-body-preauth.ts`).
 *
 * Outcome order: the guard 401, the rate limit 429, the Zod pipe 400 (closed
 * body), then the service: 400 for a `previousTerminalId` outside the device's
 * store, 409 `quarantine_conflict`, 201 for a first upload, 200 for a repeat.
 * No `Idempotency-Key`: the idempotency is the sale's provenance.
 */
import { Body, Controller, Header, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";

import { Auditable } from "../../../audit/auditable.decorator";
import { PosDeviceAuthGuard } from "../../../auth/pos-device-auth.guard";
import { PosWriteRateLimitBucket } from "../../../auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../../../auth/pos-write-rate-limit.guard";
import { DeviceBearer } from "../../../auth/route-auth";
import { ZodValidationPipe } from "../../../common/zod-validation.pipe";
import type { TenantContextRequest } from "../../../context/types";
import { deviceScopeOf } from "../../../pos-cashier-admissions/device-scope";
import { QuarantineSaleUploadSchema, type QuarantineReceipt, type QuarantineSaleUpload } from "./quarantine-upload.dto";
import { SaleQuarantineService } from "./sale-quarantine.service";

@Controller("api/pos/v1/quarantined-sales")
@DeviceBearer()
export class SaleQuarantineController {
  constructor(private readonly service: SaleQuarantineService) {}

  @Post()
  // The auth guard runs FIRST (resolves the device), THEN the per-device rate limit.
  @UseGuards(PosDeviceAuthGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posWriteSaleQuarantine")
  @Auditable("pos_sales.quarantine_uploaded")
  @Header("Cache-Control", "no-store")
  async upload(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(QuarantineSaleUploadSchema)) body: QuarantineSaleUpload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuarantineReceipt> {
    const result = await this.service.upload(deviceScopeOf(request), body);
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.receipt;
  }
}
