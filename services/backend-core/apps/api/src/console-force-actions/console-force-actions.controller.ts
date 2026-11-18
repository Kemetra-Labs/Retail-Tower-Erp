/**
 * ConsoleForceActionsController — RT-1445 (slice B1 of RT-1437;
 * `console-force-actions.openapi.yaml` 1.0.0-draft; owner decisions D1 to D10,
 * Confluence RETAIL page 80084994).
 *
 *   GET  /api/v1/stores/{store_id}/open-shifts          consoleListOpenShifts
 *   GET  /api/v1/shifts/{shift_id}/force-close-preview  consoleGetForceClosePreview
 *   POST /api/v1/shifts/{shift_id}/force-close          consoleForceCloseShift
 *
 * Guards, in order: `SessionOnlyAdminGuard` (a human cookie session only; a
 * cookie write without a trusted `Origin` is 403 `origin_rejected`, RT-430),
 * `TenantContextGuard` (the tenant, the membership, the support-session gate),
 * `ForceActionAccessGuard` (owner or tenant_admin with all-store access, or a
 * platform admin, RT-1462; every other caller the non-disclosing 404).
 * Then, for the write only, `@Idempotent("required")` (the shared
 * `IdempotencyInterceptor`, after the guards and before the body pipe: a
 * same-key replay is answered before validation, the fingerprint and the cap),
 * then the body pipe, then the service (contract, Evaluation order). The tenant
 * and the actor are the session's, never the request's (§II, §XII).
 *
 * The audit row is written by the service in the write's transaction, so no
 * handler carries `@Auditable`. Every 200 and 201 is `Cache-Control: no-store`.
 * Console rate-limit classes (`classes/console-force-actions.rate-limit.yaml`):
 * the open-shifts read is `expensiveRead`, the preview `jobOrPreview`, the close
 * `write`.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { assignRequestId } from "../common/request-id.interceptor";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import { Idempotent } from "../idempotency/idempotent.decorator";
import { toShiftHttpError } from "../pos-shifts/shift-cash-up.errors";
import { settle } from "../pos-shifts/shift-cash-up.controller";
import type { ConsoleForceClosedShiftProjection } from "../pos-shifts/shift-force-close.service";
import {
  ConsoleForceCloseRequestSchema,
  ShiftIdParamSchema,
  StoreIdParamSchema,
  type ConsoleForceCloseRequestDto,
} from "./console-force-actions.dto";
import type { ForceClosePreviewBody, OpenShiftListBody } from "./console-force-actions.projections";
import { ConsoleForceActionsService, ConsoleStoreNotFoundError } from "./console-force-actions.service";
import { ForceActionRateLimitedError } from "../console-action-cap/force-action-cap";
import { ForceActionAccessGuard, forceActionActor, type ForceActionRequest } from "./force-action-access.guard";

/** The one 404 body of a missing store: equal to the guard's refusal (FR-ISO-4). */
const NOT_FOUND_MESSAGE = "Not Found";

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard, ForceActionAccessGuard)
export class ConsoleForceActionsController {
  constructor(private readonly service: ConsoleForceActionsService) {}

  @Get("api/v1/stores/:store_id/open-shifts")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("expensiveRead")
  async listOpenShifts(
    @Req() request: ForceActionRequest,
    @Param("store_id", new ZodValidationPipe(StoreIdParamSchema)) storeId: string,
  ): Promise<OpenShiftListBody> {
    const actor = forceActionActor(request);
    try {
      return await this.service.listOpenShifts(actor.tenantId, storeId);
    } catch (err) {
      if (err instanceof ConsoleStoreNotFoundError) throw new NotFoundException(NOT_FOUND_MESSAGE);
      throw err;
    }
  }

  @Get("api/v1/shifts/:shift_id/force-close-preview")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("jobOrPreview")
  async getForceClosePreview(
    @Req() request: ForceActionRequest,
    @Param("shift_id", new ZodValidationPipe(ShiftIdParamSchema)) shiftId: string,
  ): Promise<ForceClosePreviewBody> {
    const actor = forceActionActor(request);
    return mapped(() => this.service.previewForceClose(actor.tenantId, shiftId));
  }

  @Post("api/v1/shifts/:shift_id/force-close")
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  async forceCloseShift(
    @Req() request: ForceActionRequest,
    @Param("shift_id", new ZodValidationPipe(ShiftIdParamSchema)) shiftId: string,
    @Body(new ZodValidationPipe(ConsoleForceCloseRequestSchema)) body: ConsoleForceCloseRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleForceClosedShiftProjection> {
    const actor = forceActionActor(request);
    const result = await mapped(
      () =>
        this.service.forceCloseShift(
          {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            actor,
            requestId: request.requestId ?? null,
          },
          shiftId,
          body,
        ),
      (err) => rateLimited(err, request, res),
    );
    return settle(res, result);
  }
}

/** The result of a service call, its refusals mapped to the contract (any other error propagates). */
async function mapped<T>(work: () => Promise<T>, extra?: (err: unknown) => unknown): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw (extra?.(err) ?? toShiftHttpError(err)) as Error;
  }
}

/** 429 `force_action_rate_limited` (D9) with `Retry-After`, `no-store` and `X-Request-Id`, as the console 429s carry them. */
function rateLimited(err: unknown, request: ForceActionRequest, res: Response): unknown {
  if (!(err instanceof ForceActionRateLimitedError)) return undefined;
  assignRequestId(request, res);
  res.setHeader("Retry-After", String(err.retryAfterSeconds));
  res.setHeader("Cache-Control", "no-store");
  return new HttpException(
    { code: "force_action_rate_limited", message: "Too many force actions. Try again later." },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
