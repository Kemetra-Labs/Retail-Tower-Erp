/**
 * OffersConsoleController — the Console operations of `offers.openapi.yaml`
 * (Jira RT-1337, RT-286 S4):
 *
 *   GET  /api/v1/offers                       consoleListOffers
 *   POST /api/v1/offers                       consoleCreateOfferDraft
 *   GET  /api/v1/offers/{offer_id}            consoleGetOffer
 *   PUT  /api/v1/offers/{offer_id}/draft      consoleUpdateOfferDraft
 *   POST /api/v1/offers/{offer_id}/preview    consolePreviewOffer
 *   POST /api/v1/offers/{offer_id}/publish    consolePublishOffer
 *   POST /api/v1/offers/{offer_id}/pause      consolePauseOffer
 *   POST /api/v1/offers/{offer_id}/resume     consoleResumeOffer
 *   POST /api/v1/offers/{offer_id}/end        consoleEndOffer
 *   POST /api/v1/offers/{offer_id}/archive    consoleArchiveOffer
 *   GET  /api/v1/offers/{offer_id}/versions   consoleListOfferVersions
 *
 * AUTH: the HUMAN `cookieAuth` stack: `SessionOnlyAdminGuard` (the cookie
 * session only: any bearer is 401; the RT-430 Origin check on every cookie
 * POST and PUT), `TenantContextGuard`, then `RolesGuard` (a role outside the
 * operation's set is 403 `forbidden`). The tenant is the session's, never a
 * request value. OD-12 capabilities and the store-manager bounds are decided
 * by the service (`offer-capabilities.ts`).
 *
 * Every write is `@Idempotent("required")`; its audit row is written by the
 * service in the write's own transaction, so the writes carry no `@Auditable`.
 * The reads, and the preview (it changes nothing), are audited by the
 * interceptor.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { OFFER_REFUSAL_MESSAGES, OFFER_REFUSAL_STATUS, OfferRefusedError } from "./offer-errors";
import { Idempotent } from "../idempotency/idempotent.decorator";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { annotateAudit, Auditable } from "../audit/auditable.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/roles.decorator";
import type { TenantContextRequest } from "../context/types";
import {
  OfferCreateSchema,
  OfferIdParamSchema,
  OfferListQuerySchema,
  OfferPauseSchema,
  OfferPreviewSchema,
  OfferPublishSchema,
  OfferResumeSchema,
  OfferUpdateSchema,
  OfferVersionListQuerySchema,
  type OfferCreateBody,
  type OfferListQuery,
  type OfferPauseBody,
  type OfferPreviewBody,
  type OfferPublishBody,
  type OfferResumeBody,
  type OfferUpdateBody,
  type OfferVersionListQuery,
} from "./offers.dto";
import { OffersService, type OfferCallInput } from "./offers.service";

const READERS = ["owner", "tenant_admin", "store_manager"] as const;
const MANAGERS = ["owner", "tenant_admin"] as const;

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard, RolesGuard)
export class OffersConsoleController {
  constructor(private readonly service: OffersService) {}

  @Get("api/v1/offers")
  @Roles(...READERS, { denyAs: 403 })
  @Auditable("offers.listed")
  @ConsoleRateLimit("cheapRead")
  list(@Req() request: TenantContextRequest, @Query(new ZodValidationPipe(OfferListQuerySchema)) query: OfferListQuery) {
    return refusals(() => this.service.list(callOf(request), query));
  }

  @Post("api/v1/offers")
  @HttpCode(201)
  @Roles(...MANAGERS, { denyAs: 403 })
  @Idempotent("required")
  @ConsoleRateLimit("write")
  create(@Req() request: TenantContextRequest, @Body(new ZodValidationPipe(OfferCreateSchema)) body: OfferCreateBody) {
    return refusals(() => this.service.createDraft(callOf(request), body));
  }

  @Get("api/v1/offers/:offer_id")
  @Roles(...READERS, { denyAs: 403 })
  @Auditable("offers.read")
  @ConsoleRateLimit("cheapRead")
  get(@Req() request: TenantContextRequest, @Param("offer_id", new ZodValidationPipe(OfferIdParamSchema)) offerId: string) {
    annotateAudit(request, { offer_id: offerId });
    return refusals(() => this.service.get(callOf(request), offerId));
  }

  @Put("api/v1/offers/:offer_id/draft")
  @HttpCode(200)
  @Roles(...MANAGERS, { denyAs: 403 })
  @Idempotent("required")
  @ConsoleRateLimit("write")
  updateDraft(
    @Req() request: TenantContextRequest,
    @Param("offer_id", new ZodValidationPipe(OfferIdParamSchema)) offerId: string,
    @Body(new ZodValidationPipe(OfferUpdateSchema)) body: OfferUpdateBody,
  ) {
    return refusals(() => this.service.updateDraft(callOf(request), offerId, body));
  }

  @Post("api/v1/offers/:offer_id/preview")
  @HttpCode(200)
  @Roles(...MANAGERS, { denyAs: 403 })
  @Auditable("offers.previewed")
  @ConsoleRateLimit("expensiveRead")
  preview(
    @Req() request: TenantContextRequest,
    @Param("offer_id", new ZodValidationPipe(OfferIdParamSchema)) offerId: string,
    @Body(new ZodValidationPipe(OfferPreviewSchema)) body: OfferPreviewBody,
  ) {
    annotateAudit(request, { offer_id: offerId });
    return refusals(() => this.service.preview(callOf(request), offerId, body));
  }

  @Post("api/v1/offers/:offer_id/publish")
  @HttpCode(200)
  @Roles(...MANAGERS, { denyAs: 403 })
  @Idempotent("required")
  @ConsoleRateLimit("write")
  publish(
    @Req() request: TenantContextRequest,
    @Param("offer_id", new ZodValidationPipe(OfferIdParamSchema)) offerId: string,
    @Body(new ZodValidationPipe(OfferPublishSchema)) body: OfferPublishBody,
  ) {
    return refusals(() => this.service.publish(callOf(request), offerId, body));
  }

  @Post("api/v1/offers/:offer_id/pause")
  @HttpCode(200)
  @Roles(...READERS, { denyAs: 403 })
  @Idempotent("required")
  @ConsoleRateLimit("incidentControl")
  pause(
    @Req() request: TenantContextRequest,
    @Param("offer_id", new ZodValidationPipe(OfferIdParamSchema)) offerId: string,
    @Body(new ZodValidationPipe(OfferPauseSchema)) body: OfferPauseBody,
  ) {
    return refusals(() => this.service.pause(callOf(request), offerId, body));
  }

  @Post("api/v1/offers/:offer_id/resume")
  @HttpCode(200)
  @Roles(...MANAGERS, { denyAs: 403 })
  @Idempotent("required")
  @ConsoleRateLimit("write")
  resume(
    @Req() request: TenantContextRequest,
    @Param("offer_id", new ZodValidationPipe(OfferIdParamSchema)) offerId: string,
    @Body(new ZodValidationPipe(OfferResumeSchema)) body: OfferResumeBody,
  ) {
    return refusals(() => this.service.resume(callOf(request), offerId, body));
  }

  @Post("api/v1/offers/:offer_id/end")
  @HttpCode(200)
  @Roles(...MANAGERS, { denyAs: 403 })
  @Idempotent("required")
  @ConsoleRateLimit("incidentControl")
  end(@Req() request: TenantContextRequest, @Param("offer_id", new ZodValidationPipe(OfferIdParamSchema)) offerId: string) {
    return refusals(() => this.service.end(callOf(request), offerId));
  }

  @Post("api/v1/offers/:offer_id/archive")
  @HttpCode(200)
  @Roles(...MANAGERS, { denyAs: 403 })
  @Idempotent("required")
  @ConsoleRateLimit("write")
  archive(@Req() request: TenantContextRequest, @Param("offer_id", new ZodValidationPipe(OfferIdParamSchema)) offerId: string) {
    return refusals(() => this.service.archive(callOf(request), offerId));
  }

  @Get("api/v1/offers/:offer_id/versions")
  @Roles(...READERS, { denyAs: 403 })
  @Auditable("offers.versions_listed")
  @ConsoleRateLimit("cheapRead")
  versions(
    @Req() request: TenantContextRequest,
    @Param("offer_id", new ZodValidationPipe(OfferIdParamSchema)) offerId: string,
    @Query(new ZodValidationPipe(OfferVersionListQuerySchema)) query: OfferVersionListQuery,
  ) {
    annotateAudit(request, { offer_id: offerId });
    return refusals(() => this.service.versions(callOf(request), offerId, query));
  }
}

/** The session's tenant and user; both are always set behind the cookie guards, anything else is a 401. */
function callOf(request: TenantContextRequest): OfferCallInput {
  const { context, requestId } = request;
  const tenantId = context?.tenantId ?? null;
  const actorUserId = context?.userId ?? null;
  if (context === undefined || tenantId === null || actorUserId === null) throw new UnauthorizedException("Unauthorized");
  return { actorUserId, requestId: requestId ?? null, tenantId, context };
}

/** Maps the service's closed refusals to the contract's status and `OfferError` body; anything else is a 500. */
async function refusals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof OfferRefusedError) {
      throw new HttpException(
        {
          code: err.code,
          message: OFFER_REFUSAL_MESSAGES[err.code],
          ...(err.conflicts === undefined ? {} : { conflicts: err.conflicts }),
        },
        OFFER_REFUSAL_STATUS[err.code],
      );
    }
    throw err;
  }
}
