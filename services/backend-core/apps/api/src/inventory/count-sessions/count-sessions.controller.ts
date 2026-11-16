/**
 * CountSessionsController — Jira RT-1420 (RT-292 Gate 6; contract RT-1419,
 * `inventory/inventory.yaml` 1.15.0-draft). Eleven operations under
 * `/api/inventory/v1/stores/{storeId}/count-sessions`.
 *
 * Auth: the cookieAuth operator surface. `RolesGuard` admits owner,
 * tenant_admin and store_manager (denyAs 403: the active tenant is the
 * caller's own). The path store is authorized object-level
 * (`authorizeInventoryStore`): a store_manager acts only in its store scope and
 * a store outside it is a non-disclosing 404. Bodies are strict Zod DTOs;
 * tenant, store and actor never come from the body (FR-052). Every command is
 * `@Idempotent('required')`. DARK: the service answers 404 until the tenant's
 * `count_sessions_enabled` is on.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { INVENTORY_STATUSES } from '@data-pulse-2/db';
import { z } from 'zod';

import { Idempotent } from '../../idempotency/idempotent.decorator';
import { ConsoleRateLimit } from '../../console-rate-limit/console-rate-limit.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TenantContextGuard } from '../../context/tenant-context.guard';
import type { ResolvedContext, TenantContextRequest } from '../../context/types';
import { DashboardAuthGuard } from '../../auth/dashboard-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { authorizeInventoryStore } from '../inventory.controller';
import { COUNT_SESSION_STATES } from './count-session.rules';
import { CountSessionsService, type CountCaller } from './count-sessions.service';
import type {
  CountSessionBody,
  FindingBody,
  ObservationBody,
  VarianceLineBody,
} from './count-session.store';

const UuidSchema = z.string().uuid();
const CursorSchema = z.string().min(1).max(1024).optional();
const LimitSchema = z.coerce.number().int().min(1).max(200).default(50);
const StateSchema = z.enum(COUNT_SESSION_STATES).optional();
const FlaggedSchema = z.enum(['true', 'false']).optional();

const QuantitySchema = z
  .string()
  .regex(
    /^\d{1,15}(\.\d{1,4})?$/,
    'countedQuantity must be an unsigned numeric(19,4) decimal string',
  );
const NoteSchema = z.string().max(500);
const ReasonSchema = z.string().trim().min(1).max(500);

/** Contract `CreateCountSessionCommand`. */
const CreateSessionSchema = z
  .object({
    scope: z
      .object({
        kind: z.literal('products'),
        productIds: z.array(z.string().uuid()).min(1).max(500),
      })
      .strict()
      .refine((s) => new Set(s.productIds).size === s.productIds.length, {
        message: 'productIds must be unique',
      }),
    note: NoteSchema.nullable().optional(),
  })
  .strict();

/** Contract `RecordCountObservationsCommand`. */
const ObservationsSchema = z
  .object({
    observations: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            locationId: z.string().uuid(),
            inventoryStatus: z.enum(INVENTORY_STATUSES),
            countedQuantity: QuantitySchema,
            stockingUnit: z.string().trim().min(1).max(32),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

/** Contract `RequestCountRecountCommand`. */
const RecountSchema = z
  .object({
    productIds: z
      .array(z.string().uuid())
      .min(1)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'productIds must be unique' }),
    reason: ReasonSchema,
  })
  .strict();

/** Contract `ApproveCountSessionCommand`. */
const ApproveSchema = z
  .object({
    acknowledgements: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            lineVersion: z.string().min(1).max(64),
            note: NoteSchema.nullable().optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

/** Contract `CancelCountSessionCommand`. */
const CancelSchema = z.object({ reason: ReasonSchema }).strict();

/** The path ids, validated as UUIDs. */
const StoreId = (): ParameterDecorator => Param('storeId', new ZodValidationPipe(UuidSchema));
const SessionId = (): ParameterDecorator => Param('sessionId', new ZodValidationPipe(UuidSchema));

const ROLES = ['owner', 'tenant_admin', 'store_manager'] as const;
const BASE = 'api/inventory/v1/stores/:storeId/count-sessions';

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class CountSessionsController {
  constructor(private readonly service: CountSessionsService) {}

  @Post(BASE)
  @HttpCode(HttpStatus.CREATED)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async createCountSession(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @Body(new ZodValidationPipe(CreateSessionSchema)) body: z.infer<typeof CreateSessionSchema>,
  ): Promise<CountSessionBody> {
    const caller = this.caller(request, storeId);
    return await this.service.createSession(
      caller,
      storeId,
      body.scope.productIds,
      body.note ?? null,
    );
  }

  @Get(BASE)
  @Roles(...ROLES, { denyAs: 403 })
  async listCountSessions(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @Query('state', new ZodValidationPipe(StateSchema))
    state: (typeof COUNT_SESSION_STATES)[number] | undefined,
    @Query('cursor', new ZodValidationPipe(CursorSchema)) cursor: string | undefined,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number,
  ): Promise<{ items: CountSessionBody[]; nextCursor: string | null }> {
    const caller = this.caller(request, storeId);
    return await this.service.listSessions(caller, storeId, state ?? null, cursor ?? null, limit);
  }

  @Get(`${BASE}/:sessionId`)
  @Roles(...ROLES, { denyAs: 403 })
  async getCountSession(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @SessionId() sessionId: string,
  ): Promise<CountSessionBody> {
    return await this.service.getSession(this.caller(request, storeId), storeId, sessionId);
  }

  @Post(`${BASE}/:sessionId/observations`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async recordCountObservations(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @SessionId() sessionId: string,
    @Body(new ZodValidationPipe(ObservationsSchema)) body: z.infer<typeof ObservationsSchema>,
  ): Promise<{ sessionId: string; observations: ObservationBody[] }> {
    return await this.service.recordObservations(
      this.caller(request, storeId),
      storeId,
      sessionId,
      body.observations,
    );
  }

  @Post(`${BASE}/:sessionId/cut`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async takeCountCut(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @SessionId() sessionId: string,
  ): Promise<CountSessionBody> {
    return await this.service.takeCut(this.caller(request, storeId), storeId, sessionId);
  }

  @Post(`${BASE}/:sessionId/submit`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async submitCountSession(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @SessionId() sessionId: string,
  ): Promise<CountSessionBody> {
    return await this.service.submit(this.caller(request, storeId), storeId, sessionId);
  }

  @Get(`${BASE}/:sessionId/variance-lines`)
  @Roles(...ROLES, { denyAs: 403 })
  @ConsoleRateLimit('expensiveRead')
  async listCountVarianceLines(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @SessionId() sessionId: string,
    @Query('flagged', new ZodValidationPipe(FlaggedSchema)) flagged: 'true' | 'false' | undefined,
    @Query('cursor', new ZodValidationPipe(CursorSchema)) cursor: string | undefined,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number,
  ): Promise<{ items: VarianceLineBody[]; nextCursor: string | null }> {
    return await this.service.listVarianceLines(
      this.caller(request, storeId),
      storeId,
      sessionId,
      flagged === undefined ? null : flagged === 'true',
      cursor ?? null,
      limit,
    );
  }

  @Post(`${BASE}/:sessionId/recount`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async requestCountRecount(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @SessionId() sessionId: string,
    @Body(new ZodValidationPipe(RecountSchema)) body: z.infer<typeof RecountSchema>,
  ): Promise<CountSessionBody> {
    return await this.service.requestRecount(
      this.caller(request, storeId),
      storeId,
      sessionId,
      body.productIds,
      body.reason,
    );
  }

  @Post(`${BASE}/:sessionId/approve`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async approveCountSession(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @SessionId() sessionId: string,
    @Body(new ZodValidationPipe(ApproveSchema)) body: z.infer<typeof ApproveSchema>,
  ): Promise<CountSessionBody> {
    return await this.service.approve(
      this.caller(request, storeId),
      storeId,
      sessionId,
      body.acknowledgements.map((a) => ({
        productId: a.productId,
        lineVersion: a.lineVersion,
        note: a.note ?? null,
      })),
    );
  }

  @Post(`${BASE}/:sessionId/cancel`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async cancelCountSession(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @SessionId() sessionId: string,
    @Body(new ZodValidationPipe(CancelSchema)) body: z.infer<typeof CancelSchema>,
  ): Promise<CountSessionBody> {
    return await this.service.cancel(
      this.caller(request, storeId),
      storeId,
      sessionId,
      body.reason,
    );
  }

  @Get(`${BASE}/:sessionId/late-event-findings`)
  @Roles(...ROLES, { denyAs: 403 })
  async listCountLateEventFindings(
    @Req() request: TenantContextRequest,
    @StoreId() storeId: string,
    @SessionId() sessionId: string,
    @Query('cursor', new ZodValidationPipe(CursorSchema)) cursor: string | undefined,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number,
  ): Promise<{ items: FindingBody[]; nextCursor: string | null }> {
    return await this.service.listLateEventFindings(
      this.caller(request, storeId),
      storeId,
      sessionId,
      cursor ?? null,
      limit,
    );
  }

  /** The tenant-bound principal, with the path store authorized (404 outside its scope). */
  private caller(request: TenantContextRequest, storeId: string): CountCaller {
    const ctx: ResolvedContext | undefined = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null)
      throw new UnauthorizedException('Unauthorized');
    authorizeInventoryStore(ctx, storeId);
    return { tenantId: ctx.tenantId, userId: ctx.userId };
  }
}
