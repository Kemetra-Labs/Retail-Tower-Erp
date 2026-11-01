/**
 * InventorySafetyController — Jira RT-449 PR 1 (RT-50 Gate 7 G7-2 / G7-6 /
 * G7-7; owner rulings H1–H8, RT-449 comment 13434).
 *
 *   POST /api/inventory/v1/tracking-holds                    → placeQualityHold
 *   GET  /api/inventory/v1/tracking-holds/{holdId}           → getTrackingHold
 *   POST /api/inventory/v1/tracking-holds/{holdId}/release   → releaseTrackingHold
 *   POST /api/inventory/v1/recalls                           → createInventoryRecall
 *   GET  /api/inventory/v1/recalls/{recallId}                → getInventoryRecall
 *   POST /api/inventory/v1/tracking-identities/{identityId}/expiry-corrections
 *                                                            → correctTrackingIdentityExpiry
 *
 * RT-449 PR 2 (rulings H6, H8):
 *
 *   GET  /api/inventory/v1/settings/safety-ttl               → getSafetyTtlSetting
 *   PUT  /api/inventory/v1/settings/safety-ttl               → setSafetyTtlSetting
 *   GET  /api/inventory/v1/safety/findings                   → listInventorySafetyFindings
 *
 * The two reads also admit a store_manager: the Safety TTL is the tenant's
 * (as the return landing policy), and the service filters the findings to the
 * caller's store scope (H6). Setting the TTL is owner / tenant_admin; the
 * service audits it.
 *
 * Auth (H1, H2; decision 965): the cookieAuth operator surface. These are
 * TENANT-level operations — a hold reaches the identity at every location of
 * every store — so no store scope can admit a caller: `RolesGuard` admits
 * owner and tenant_admin to the placements, the recall, the expiry
 * correction and the reads, and only the owner to a release (higher
 * sensitivity than placement). A store_manager is a 403 (denyAs 403: the
 * active tenant is the caller's own, so nothing is disclosed). As on every
 * `@Roles` route, a platform-admin session passes `RolesGuard` (RT-132 D6,
 * RT-414 support sessions).
 *
 * Bodies are strict Zod DTOs: tenant, store and actor are never accepted from
 * the body (FR-052). Placement, recall and expiry correction are
 * `@Idempotent('required')`; the services also record a fingerprint of the
 * key, so a replay never writes twice. A release needs no key: a released
 * hold is final and a second release writes nothing. Audit rows are written
 * by the services in the command's transaction (no `@Auditable`).
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
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SAFETY_REASON_CODE_PATTERN } from '@data-pulse-2/db';
import { z } from 'zod';

import { DashboardAuthGuard } from '../../auth/dashboard-auth.guard';
import { boundedArray } from '../../common/bounded-array';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ConsoleRateLimit } from '../../console-rate-limit/console-rate-limit.decorator';
import { TenantContextGuard } from '../../context/tenant-context.guard';
import type { ResolvedContext, TenantContextRequest } from '../../context/types';
import { Idempotent } from '../../idempotency/idempotent.decorator';
import { IdentityExpiryService, type ExpiryCorrectionResult } from './identity-expiry.service';
import {
  InventoryRecallsService,
  type InventoryRecallBody,
  type InventoryRecallResult,
} from './inventory-recalls.service';
import type { TrackingHoldBody, TrackingHoldResult } from './safety.common';
import { SafetyFindingsService, type InventorySafetyFindingList } from './safety-findings.service';
import {
  DEFAULT_SAFETY_TTL_SECONDS,
  MIN_SAFETY_TTL_SECONDS,
  SafetyTtlService,
  type SafetyTtlSettingBody,
} from './safety-ttl.service';
import { TrackingHoldsService } from './tracking-holds.service';

const UuidSchema = z.string().uuid();
const ReasonCodeSchema = z.string().regex(SAFETY_REASON_CODE_PATTERN);
const NoteSchema = z.string().max(500).optional();

/** Contract `PlaceQualityHoldCommand` (`additionalProperties: false`). */
const PlaceQualityHoldSchema = z
  .object({ trackingIdentityId: UuidSchema, reasonCode: ReasonCodeSchema, note: NoteSchema })
  .strict();
type PlaceQualityHoldDto = z.infer<typeof PlaceQualityHoldSchema>;

/** Contract `ReleaseTrackingHoldCommand`; the body itself is optional. */
const ReleaseTrackingHoldSchema = z.object({ note: NoteSchema }).strict().optional();
type ReleaseTrackingHoldDto = z.infer<typeof ReleaseTrackingHoldSchema>;

/** Contract `CreateInventoryRecallCommand`. */
const CreateInventoryRecallSchema = z
  .object({
    tenantProductRef: UuidSchema,
    trackingIdentityIds: boundedArray(
      100,
      z
        .array(UuidSchema)
        .min(1)
        .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
          message: 'trackingIdentityIds must not repeat an identity',
        }),
    ),
    reasonCode: ReasonCodeSchema,
    reference: z.string().trim().min(1).max(200),
    note: NoteSchema,
    effectiveAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
type CreateInventoryRecallDto = z.infer<typeof CreateInventoryRecallSchema>;

/** Contract `CorrectTrackingIdentityExpiryCommand` (`expiryDate` required, nullable). */
const CorrectExpirySchema = z
  .object({
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    reasonCode: ReasonCodeSchema,
    note: NoteSchema,
  })
  .strict();
type CorrectExpiryDto = z.infer<typeof CorrectExpirySchema>;

/** Contract `SetSafetyTtlSettingCommand` (H8: 60–900, or null for the default). */
const SetSafetyTtlSchema = z
  .object({
    safetyTtlSeconds: z
      .number()
      .int()
      .min(MIN_SAFETY_TTL_SECONDS)
      .max(DEFAULT_SAFETY_TTL_SECONDS)
      .nullable(),
  })
  .strict();
type SetSafetyTtlDto = z.infer<typeof SetSafetyTtlSchema>;

/** The resolved caller of a safety command. */
interface SafetyActor {
  readonly tenantId: string;
  readonly userId: string;
}

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class InventorySafetyController {
  constructor(
    private readonly holds: TrackingHoldsService,
    private readonly recalls: InventoryRecallsService,
    private readonly expiry: IdentityExpiryService,
    private readonly safetyTtl: SafetyTtlService,
    private readonly findings: SafetyFindingsService,
  ) {}

  /** Place a quality hold on a tracking identity (G7-6). */
  @Post('api/inventory/v1/tracking-holds')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  @Idempotent('required')
  async placeQualityHold(
    @Req() request: TenantContextRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(PlaceQualityHoldSchema)) body: PlaceQualityHoldDto,
  ): Promise<TrackingHoldResult> {
    return await this.holds.placeQualityHold({
      ...actor(request),
      idempotencyKey: requireKey(idempotencyKey),
      trackingIdentityId: body.trackingIdentityId,
      reasonCode: body.reasonCode,
      note: body.note ?? null,
    });
  }

  /** One hold of the tenant. */
  @Get('api/inventory/v1/tracking-holds/:holdId')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async getTrackingHold(
    @Req() request: TenantContextRequest,
    @Param('holdId', new ZodValidationPipe(UuidSchema)) holdId: string,
  ): Promise<TrackingHoldBody> {
    return await this.holds.getHold(actor(request).tenantId, holdId);
  }

  /** Release a hold: owner only (965, H1). */
  @Post('api/inventory/v1/tracking-holds/:holdId/release')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', { denyAs: 403 })
  async releaseTrackingHold(
    @Req() request: TenantContextRequest,
    @Param('holdId', new ZodValidationPipe(UuidSchema)) holdId: string,
    @Body(new ZodValidationPipe(ReleaseTrackingHoldSchema)) body: ReleaseTrackingHoldDto,
  ): Promise<TrackingHoldResult> {
    return await this.holds.releaseHold({ ...actor(request), holdId, note: body?.note ?? null });
  }

  /** Recall listed identities of one product (860). */
  @Post('api/inventory/v1/recalls')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  @Idempotent('required')
  async createInventoryRecall(
    @Req() request: TenantContextRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(CreateInventoryRecallSchema)) body: CreateInventoryRecallDto,
  ): Promise<InventoryRecallResult> {
    return await this.recalls.createRecall({
      ...actor(request),
      idempotencyKey: requireKey(idempotencyKey),
      tenantProductRef: body.tenantProductRef,
      trackingIdentityIds: body.trackingIdentityIds,
      reasonCode: body.reasonCode,
      reference: body.reference,
      note: body.note ?? null,
      effectiveAt: body.effectiveAt ?? null,
    });
  }

  /** One recall of the tenant with its holds. */
  @Get('api/inventory/v1/recalls/:recallId')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async getInventoryRecall(
    @Req() request: TenantContextRequest,
    @Param('recallId', new ZodValidationPipe(UuidSchema)) recallId: string,
  ): Promise<InventoryRecallBody> {
    return await this.recalls.getRecall(actor(request).tenantId, recallId);
  }

  /** Correct an identity's expiry date, with history (G7-2, H7). */
  @Post('api/inventory/v1/tracking-identities/:identityId/expiry-corrections')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  @Idempotent('required')
  async correctTrackingIdentityExpiry(
    @Req() request: TenantContextRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('identityId', new ZodValidationPipe(UuidSchema)) identityId: string,
    @Body(new ZodValidationPipe(CorrectExpirySchema)) body: CorrectExpiryDto,
  ): Promise<ExpiryCorrectionResult> {
    return await this.expiry.correctExpiry({
      ...actor(request),
      idempotencyKey: requireKey(idempotencyKey),
      trackingIdentityId: identityId,
      expiryDate: body.expiryDate,
      reasonCode: body.reasonCode,
      note: body.note ?? null,
    });
  }

  /** The tenant's Safety TTL of the POS inventory safety feed (H8). */
  @Get('api/inventory/v1/settings/safety-ttl')
  @Roles('owner', 'tenant_admin', 'store_manager', { denyAs: 403 })
  async getSafetyTtlSetting(@Req() request: TenantContextRequest): Promise<SafetyTtlSettingBody> {
    return await this.safetyTtl.getSafetyTtl(actor(request).tenantId);
  }

  /** Set the tenant's Safety TTL, downwards only (H8). */
  @Put('api/inventory/v1/settings/safety-ttl')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async setSafetyTtlSetting(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(SetSafetyTtlSchema)) body: SetSafetyTtlDto,
  ): Promise<SafetyTtlSettingBody> {
    return await this.safetyTtl.setSafetyTtl({
      ...actor(request),
      safetyTtlSeconds: body.safetyTtlSeconds,
    });
  }

  /** The tenant's computed safety findings in the caller's store scope (H6). */
  @Get('api/inventory/v1/safety/findings')
  @Roles('owner', 'tenant_admin', 'store_manager', { denyAs: 403 })
  @ConsoleRateLimit('expensiveRead')
  async listInventorySafetyFindings(
    @Req() request: TenantContextRequest,
  ): Promise<InventorySafetyFindingList> {
    const { tenantId } = actor(request);
    return await this.findings.listFindings({
      tenantId,
      context: request.context as ResolvedContext,
    });
  }
}

/** An authenticated, tenant-bound principal. */
function actor(request: TenantContextRequest): SafetyActor {
  const tenantId = request.context?.tenantId ?? null;
  const userId = request.context?.userId ?? null;
  if (tenantId === null) throw new UnauthorizedException('Unauthorized');
  if (userId === null) throw new UnauthorizedException('Unauthorized');
  return { tenantId, userId };
}

/** `@Idempotent('required')` rejects a request without the header first. */
function requireKey(idempotencyKey: string | undefined): string {
  if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
  return idempotencyKey;
}
