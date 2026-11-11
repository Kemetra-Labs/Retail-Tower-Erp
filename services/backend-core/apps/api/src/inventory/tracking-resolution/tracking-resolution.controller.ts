/**
 * TrackingResolutionController — Jira RT-451 slice S5 (scope item 4; RT-455
 * TR-2, OD-1, OD-9; RT-50 DC-2, G7-9 row 4).
 *
 *   GET  /api/inventory/v1/tracking-resolutions              → listTrackingResolutionQueue
 *   POST /api/inventory/v1/tracking-resolutions/{saleId}/bind → bindTrackingResolution
 *
 * The cookieAuth operator surface. The queue admits owner, tenant_admin and
 * store_manager; the service gives a store_manager only the count of its own
 * stores (OD-9). The bind is owner only (high sensitivity, as
 * `releaseTrackingHold`). Any other role is a 403 (denyAs 403: the active
 * tenant is the caller's own, so nothing is disclosed). As on every `@Roles`
 * route, a platform-admin session passes `RolesGuard`; the queue then reads
 * the count only.
 *
 * Bodies are strict Zod DTOs: tenant, sale scope and actor are never accepted
 * from the body (FR-052). The bind is `@Idempotent('required')`; the service
 * also records a fingerprint of the key, so a replay never writes twice. Its
 * audit row is written by the service in the bind's transaction (no
 * `@Auditable`). Console rate-limit classes: the queue `expensiveRead`, the
 * bind `write` (the default).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import {
  TrackingResolutionService,
  type TrackingResolutionBody,
  type TrackingResolutionQueueBody,
} from './tracking-resolution.service';
import type { ResolvedContext, TenantContextRequest } from '../../context/types';
import { TenantContextGuard } from '../../context/tenant-context.guard';
import { DashboardAuthGuard } from '../../auth/dashboard-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { Idempotent } from '../../idempotency/idempotent.decorator';
import { ConsoleRateLimit } from '../../console-rate-limit/console-rate-limit.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

const UuidSchema = z.string().uuid();

/** Query of `listTrackingResolutionQueue` (unknown parameters are ignored, as on the other lists). */
const ListQueueQuerySchema = z.object({
  status: z.enum(['unresolved', 'resolved', 'all']).optional(),
  storeId: UuidSchema.optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
type ListQueueQuery = z.infer<typeof ListQueueQuerySchema>;

/** Contract `BindTrackingResolutionCommand` (`additionalProperties: false`). */
const BindSchema = z
  .object({
    // Contract `SafetyReasonCode`; the service checks the pattern.
    reasonCode: z.string().min(1).max(64),
    note: z.string().min(1).max(500),
    lines: z
      .array(z.object({ saleLineId: UuidSchema, trackingIdentityId: UuidSchema }).strict())
      .min(1),
  })
  .strict();
type BindDto = z.infer<typeof BindSchema>;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class TrackingResolutionController {
  constructor(private readonly resolutions: TrackingResolutionService) {}

  /** The Tracking Resolution queue, newest capture first, and the unresolved count. */
  @Get('api/inventory/v1/tracking-resolutions')
  @Roles('owner', 'tenant_admin', 'store_manager', { denyAs: 403 })
  @ConsoleRateLimit('expensiveRead')
  async listTrackingResolutionQueue(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListQueueQuerySchema)) query: ListQueueQuery,
  ): Promise<TrackingResolutionQueueBody> {
    const { tenantId } = actor(request);
    return await this.resolutions.listQueue({ tenantId, context: request.context as ResolvedContext, ...query });
  }

  /** Resolve a `tracking_unresolved` sale: owner only. */
  @Post('api/inventory/v1/tracking-resolutions/:saleId/bind')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', { denyAs: 403 })
  @Idempotent('required')
  async bindTrackingResolution(
    @Req() request: TenantContextRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('saleId', new ZodValidationPipe(UuidSchema)) saleId: string,
    @Body(new ZodValidationPipe(BindSchema)) body: BindDto,
  ): Promise<TrackingResolutionBody> {
    const { tenantId, userId } = actor(request);
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    return await this.resolutions.bind({
      tenantId,
      userId,
      context: request.context as ResolvedContext,
      idempotencyKey,
      saleId,
      reasonCode: body.reasonCode,
      note: body.note,
      lines: body.lines,
    });
  }
}

/** An authenticated, tenant-bound principal. */
function actor(request: TenantContextRequest): { tenantId: string; userId: string } {
  const tenantId = request.context?.tenantId ?? null;
  const userId = request.context?.userId ?? null;
  if (tenantId === null || userId === null) throw new UnauthorizedException('Unauthorized');
  return { tenantId, userId };
}
