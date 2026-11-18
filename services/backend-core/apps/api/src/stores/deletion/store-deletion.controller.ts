/**
 * Store deletion routes — RT-1439 (RT-1437 B2; `stores.openapi.yaml` 1.3.0-draft and
 * `console-force-actions.openapi.yaml` 1.0.0-draft):
 *
 *     GET  /api/v1/stores/{store_id}/deletion-preview   previewStoreDeletion
 *     POST /api/v1/stores/{store_id}/deletion           consoleDeleteStore     (Idempotency-Key required)
 *     POST /api/v1/auth/reauth                          consoleReauthenticate
 *
 * The HUMAN cookie session only (`SessionOnlyAdminGuard` -> `TenantContextGuard` -> `RolesGuard`
 * -> the owner gate): a bearer, a POS device token or an operator envelope is 401. Owner only
 * (D1): a `tenant_admin` is 403 `store_deletion_owner_only` and every other caller is the
 * non-disclosing 404. Since RT-1462 a platform admin is admitted too (a member or not, and without
 * a support session) and the audit records `actor_kind: platform_admin` on behalf of the tenant. A cookie write must carry a trusted `Origin` (RT-430,
 * in `AuthGuard`).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { SessionOnlyAdminGuard } from "../../auth/session-only-admin.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import type { ForceActionAuditActor } from "../../common/force-action-actor";
import { ConsoleRateLimit } from "../../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import { ConsoleActionRateLimited, consoleRateLimited } from "../../console-action-cap/console-429";
import { ConsoleReauthService, type ReauthGrantBody } from "./reauth.service";
import {
  ReauthRequestSchema,
  StoreDeletionRequestSchema,
  type ReauthRequest,
  type StoreDeletionRequest,
} from "./store-deletion.dto";
import {
  ReauthRoleGuard,
  StoreDeletionOwnerGuard,
  type StoreDeletionRequestWithRole,
} from "./store-deletion-owner.guard";
import { StoreDeletionService, type StoreDeletionPreview } from "./store-deletion.service";

/** The caller as the session carries it; a non-session principal never reaches here (SessionOnlyAdminGuard). */
function callerOf(request: StoreDeletionRequestWithRole): {
  tenantId: string;
  userId: string;
  sessionId: string;
  actor: ForceActionAuditActor;
} {
  const ctx = request.context;
  const principal = request.principal;
  const actor = request.storeDeletionActor;
  if (!ctx || ctx.tenantId === null || ctx.userId === null || principal?.kind !== "session" || actor === undefined) {
    throw new UnauthorizedException("Unauthorized");
  }
  return { tenantId: ctx.tenantId, userId: ctx.userId, sessionId: principal.sessionId, actor };
}

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class StoreDeletionController {
  constructor(
    private readonly deletion: StoreDeletionService,
    private readonly reauth: ConsoleReauthService,
  ) {}

  @Get("api/v1/stores/:store_id/deletion-preview")
  @UseGuards(RolesGuard, StoreDeletionOwnerGuard)
  @Roles("owner", "tenant_admin")
  // RT-619 (RT-574 D3): previewStoreDeletion.
  @ConsoleRateLimit("jobOrPreview")
  async preview(
    @Req() request: StoreDeletionRequestWithRole,
    @Param("store_id", new ParseUUIDPipe()) storeId: string,
  ): Promise<StoreDeletionPreview> {
    const { tenantId } = callerOf(request);
    return await this.deletion.preview(tenantId, storeId);
  }

  @Post("api/v1/stores/:store_id/deletion")
  @HttpCode(200)
  @UseGuards(RolesGuard, StoreDeletionOwnerGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  // RT-619 (RT-574 D3): consoleDeleteStore.
  @ConsoleRateLimit("write")
  async delete(
    @Req() request: StoreDeletionRequestWithRole,
    @Res({ passthrough: true }) response: Response,
    @Param("store_id", new ParseUUIDPipe()) storeId: string,
    @Body(new ZodValidationPipe(StoreDeletionRequestSchema)) body: StoreDeletionRequest,
  ): Promise<{ storeId: string; deletedAt: string }> {
    const caller = callerOf(request);
    try {
      return await this.deletion.delete({
        ...caller,
        storeId,
        reason: body.reason,
        previewFingerprint: body.previewFingerprint,
        reauthToken: body.reauthToken,
        requestId: request.requestId ?? null,
      });
    } catch (err) {
      if (err instanceof ConsoleActionRateLimited) throw consoleRateLimited(err, request, response);
      throw err;
    }
  }

  @Post("api/v1/auth/reauth")
  @HttpCode(200)
  @UseGuards(RolesGuard, ReauthRoleGuard)
  @Roles("owner", "tenant_admin")
  // RT-619 (RT-574 D3): consoleReauthenticate. The per-user failed-attempt budget is the brute-force bound.
  @ConsoleRateLimit("write")
  async reauthenticate(
    @Req() request: StoreDeletionRequestWithRole,
    @Res({ passthrough: true }) response: Response,
    @Body(new ZodValidationPipe(ReauthRequestSchema)) body: ReauthRequest,
  ): Promise<ReauthGrantBody> {
    const caller = callerOf(request);
    response.setHeader("Cache-Control", "no-store");
    try {
      return await this.reauth.reauthenticate({
        ...caller,
        storeId: body.storeId,
        purpose: body.purpose,
        password: body.password,
        requestId: request.requestId ?? null,
      });
    } catch (err) {
      if (err instanceof ConsoleActionRateLimited) throw consoleRateLimited(err, request, response);
      throw err;
    }
  }
}
