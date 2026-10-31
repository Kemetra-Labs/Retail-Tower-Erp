/**
 * TenantBrandingDeviceController — RT-473 S2: `posGetTenantBranding`
 * (tenant-branding.openapi.yaml).
 *
 *   GET /api/pos/v1/tenant/branding
 *
 * Auth (FR-16): the paired terminal's `devices` pairing token
 * (`PosDeviceAuthGuard`, the read-down scheme). The tenant comes only from the
 * device row; no query parameter is accepted (an unknown key is 400).
 *
 * "No logo" is 200 with `logo: null` (FR-17). Conditional read (FR-18): the
 * strong ETag over the display name and the revision; an `If-None-Match`
 * equal to it is 304 with no body; a malformed one is 400. Both answers carry
 * `Cache-Control: no-cache, private`.
 */
import { BadRequestException, Controller, Get, Headers, Query, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Response } from "express";

import { annotateAudit, Auditable } from "../audit/auditable.decorator";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { DeviceBearer, ReportsBuildIdentity } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { TenantContextRequest } from "../context/types";
import { IfNoneMatchSchema, NoQuerySchema } from "./branding.query";
import { brandingEtag, type TenantBrandingBody } from "./branding.projections";
import { TenantBrandingService } from "./branding.service";

const CACHE_CONTROL = "no-cache, private";

@Controller()
export class TenantBrandingDeviceController {
  constructor(private readonly service: TenantBrandingService) {}

  @Get("api/pos/v1/tenant/branding")
  @DeviceBearer()
  @UseGuards(PosDeviceAuthGuard)
  @Auditable("tenant.branding.device_read")
  @ReportsBuildIdentity()
  async read(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(NoQuerySchema)) _query: Record<string, never>,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TenantBrandingBody | undefined> {
    const tenantId = request.context?.tenantId ?? null;
    if (tenantId === null) throw new UnauthorizedException("Unauthorized");
    const wanted = IfNoneMatchSchema.safeParse(ifNoneMatch);
    if (!wanted.success) {
      throw new BadRequestException({ code: "validation_error", message: "If-None-Match is not a valid ETag." });
    }
    if (request.posDeviceId !== undefined) annotateAudit(request, { device_id: request.posDeviceId });

    const body = await this.service.read(tenantId);
    const etag = brandingEtag(body.tenant_display_name, body.revision);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", CACHE_CONTROL);
    if (wanted.data === etag) {
      res.status(304);
      return undefined;
    }
    return body;
  }
}
