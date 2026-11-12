/**
 * OffersPosController — `posGetOfferPack` (`offers.openapi.yaml`; Jira RT-1337).
 *
 *   GET /api/pos/v1/store/offer-pack
 *
 * Auth: the paired terminal's `devices` pairing token (`PosDeviceAuthGuard`).
 * Tenant and store come only from the device row; no query parameter is
 * accepted (an unknown key is 400). Conditional read: a strong `ETag` over the
 * canonical body without `issuedAt`; an `If-None-Match` equal to it is `304`
 * with no body, and a malformed one is 400. Both answers carry
 * `Cache-Control: no-cache, private` and `X-Server-Time`, the till's
 * trusted-time anchor (OD-8): the 304 counts as a successful read too.
 * A Pack read writes no audit row.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";

import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { DeviceBearer, ReportsBuildIdentity } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { TenantContextRequest } from "../context/types";
import { OfferPackService, packEtag, type OfferPackBody } from "./offer-pack.service";

const NoQuerySchema = z.object({}).strict();
const IF_NONE_MATCH = /^"[0-9a-f]{64}"$/;

@Controller()
export class OffersPosController {
  constructor(private readonly service: OfferPackService) {}

  @Get("api/pos/v1/store/offer-pack")
  @DeviceBearer()
  @UseGuards(PosDeviceAuthGuard)
  @ReportsBuildIdentity()
  async read(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(NoQuerySchema)) _query: Record<string, never>,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OfferPackBody | undefined> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.storeId === null) throw new UnauthorizedException("Unauthorized");
    if (ifNoneMatch !== undefined && !IF_NONE_MATCH.test(ifNoneMatch)) {
      throw new BadRequestException({ code: "validation_error", message: "If-None-Match is not a valid ETag." });
    }
    const body = await this.service.read({ tenantId: ctx.tenantId, storeId: ctx.storeId });
    const etag = packEtag(body);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "no-cache, private");
    res.setHeader("X-Server-Time", body.issuedAt);
    if (ifNoneMatch === etag) {
      res.status(304);
      return undefined;
    }
    return body;
  }
}
