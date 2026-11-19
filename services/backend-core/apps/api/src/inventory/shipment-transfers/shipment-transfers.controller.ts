/**
 * ShipmentTransfersController — Jira RT-1513 (RT-291 Gate 5; contract RT-1512, `inventory/inventory.yaml`
 * 1.21.0-draft). Nine operations under `/api/inventory/v1/shipment-transfers`.
 *
 * Auth: the cookieAuth operator surface. `RolesGuard` admits owner, tenant_admin and store_manager (denyAs 403: the
 * active tenant is the caller's own); the per-Transfer authority (which store the caller may act for) is decided by the
 * service from the Transfer's own stores, not from a path store. Bodies are strict Zod DTOs; tenant, stores' authority
 * and actor never come from the body (FR-052). Every command is `@Idempotent('required')`. DARK: the service answers
 * 404 until the tenant's `shipment_transfers_enabled` is on.
 *
 * Imports of other modules go through their root ports (RT-1453), not their internals.
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
import { z } from 'zod';

import { DashboardAuthGuard, Roles, RolesGuard } from '../../auth';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TenantContextGuard, type TenantContextRequest } from '../../context';
import { Idempotent } from '../../idempotency';
import { TRANSFER_STATES } from './shipment-transfer.rules';
import type { ReceiptBody, TransferBody } from './shipment-transfer.store';
import { ShipmentTransfersService, type Page, type TransferCaller } from './shipment-transfers.service';

const Uuid = z.string().uuid();
const CursorSchema = z.string().min(1).max(1024).optional();
const LimitSchema = z.coerce.number().int().min(1).max(200).default(50);
const PositiveQuantity = z
  .string()
  .regex(/^(?!0+(?:\.0+)?$)[0-9]{1,15}(\.[0-9]{1,4})?$/, 'quantity must be a strictly positive numeric(19,4) decimal string');
const Reason = z.string().trim().min(1).max(500);
const Note = z.string().max(500).nullable();

/** Contract `CreateShipmentTransferCommand`. */
const CreateSchema = z
  .object({
    sourceStoreId: Uuid,
    destinationStoreId: Uuid,
    lines: z
      .array(
        z
          .object({
            tenantProductRef: Uuid,
            quantity: PositiveQuantity,
            stockingUnit: z.string().min(1).max(32).regex(/\S/),
            trackingIdentityId: Uuid.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    reason: Note,
  })
  .strict();

/** Contract `ApproveShipmentTransferCommand`. */
const ApproveSchema = z.object({ reservationExpiresAt: z.string().datetime({ offset: true }) }).strict();

/** Contract `CancelShipmentTransferCommand`. */
const CancelSchema = z.object({ reason: Reason }).strict();

/** Contract `DispatchShipmentTransferCommand`. */
const DispatchSchema = z.object({ note: Note }).strict();

/** Contract `RecordShipmentTransferReceiptCommand`. */
const ReceiptSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            transferLineId: Uuid,
            quantity: PositiveQuantity,
            disposition: z.enum(['sellable', 'damaged']),
            stockLocationId: Uuid.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    note: Note,
  })
  .strict();

/** Contract `CloseShipmentTransferCommand`. */
const CloseSchema = z.object({ shortCloseReason: Reason.nullable() }).strict();

const ListQuerySchema = z.object({
  storeId: Uuid.optional(),
  direction: z.enum(['outbound', 'inbound', 'any']).default('any'),
  state: z.enum(TRANSFER_STATES).optional(),
  cursor: CursorSchema,
  limit: LimitSchema,
});

const TransferId = (): ParameterDecorator => Param('transferId', new ZodValidationPipe(Uuid));

const ROLES = ['owner', 'tenant_admin', 'store_manager'] as const;

const BASE = 'api/inventory/v1/shipment-transfers';

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class ShipmentTransfersController {
  constructor(private readonly service: ShipmentTransfersService) {}

  @Post(BASE)
  @HttpCode(HttpStatus.CREATED)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async createShipmentTransfer(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(CreateSchema)) body: z.infer<typeof CreateSchema>,
  ): Promise<TransferBody> {
    return await this.service.create(this.caller(request), body);
  }

  @Get(BASE)
  @Roles(...ROLES, { denyAs: 403 })
  async listShipmentTransfers(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListQuerySchema)) q: z.infer<typeof ListQuerySchema>,
  ): Promise<Page<TransferBody>> {
    return await this.service.list(
      this.caller(request),
      { storeId: q.storeId ?? null, direction: q.direction, state: q.state ?? null },
      q.cursor ?? null,
      q.limit,
    );
  }

  @Get(`${BASE}/:transferId`)
  @Roles(...ROLES, { denyAs: 403 })
  async getShipmentTransfer(@Req() request: TenantContextRequest, @TransferId() transferId: string): Promise<TransferBody> {
    return await this.service.get(this.caller(request), transferId);
  }

  @Post(`${BASE}/:transferId/approve`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async approveShipmentTransfer(
    @Req() request: TenantContextRequest,
    @TransferId() transferId: string,
    @Body(new ZodValidationPipe(ApproveSchema)) body: z.infer<typeof ApproveSchema>,
  ): Promise<TransferBody> {
    return await this.service.approve(this.caller(request), transferId, new Date(body.reservationExpiresAt));
  }

  @Post(`${BASE}/:transferId/cancel`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async cancelShipmentTransfer(
    @Req() request: TenantContextRequest,
    @TransferId() transferId: string,
    @Body(new ZodValidationPipe(CancelSchema)) body: z.infer<typeof CancelSchema>,
  ): Promise<TransferBody> {
    return await this.service.cancel(this.caller(request), transferId, body.reason);
  }

  @Post(`${BASE}/:transferId/dispatch`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async dispatchShipmentTransfer(
    @Req() request: TenantContextRequest,
    @TransferId() transferId: string,
    @Body(new ZodValidationPipe(DispatchSchema)) body: z.infer<typeof DispatchSchema>,
  ): Promise<TransferBody> {
    return await this.service.dispatch(this.caller(request), transferId, body.note);
  }

  @Post(`${BASE}/:transferId/receipts`)
  @HttpCode(HttpStatus.CREATED)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async recordShipmentTransferReceipt(
    @Req() request: TenantContextRequest,
    @TransferId() transferId: string,
    @Body(new ZodValidationPipe(ReceiptSchema)) body: z.infer<typeof ReceiptSchema>,
  ): Promise<{ transfer: TransferBody; receipt: ReceiptBody }> {
    return await this.service.receive(this.caller(request), transferId, body);
  }

  @Get(`${BASE}/:transferId/receipts`)
  @Roles(...ROLES, { denyAs: 403 })
  async listShipmentTransferReceipts(
    @Req() request: TenantContextRequest,
    @TransferId() transferId: string,
    @Query('cursor', new ZodValidationPipe(CursorSchema)) cursor: string | undefined,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number,
  ): Promise<Page<ReceiptBody>> {
    return await this.service.listReceipts(this.caller(request), transferId, cursor ?? null, limit);
  }

  @Post(`${BASE}/:transferId/close`)
  @HttpCode(HttpStatus.OK)
  @Roles(...ROLES, { denyAs: 403 })
  @Idempotent('required')
  async closeShipmentTransfer(
    @Req() request: TenantContextRequest,
    @TransferId() transferId: string,
    @Body(new ZodValidationPipe(CloseSchema)) body: z.infer<typeof CloseSchema>,
  ): Promise<TransferBody> {
    return await this.service.close(this.caller(request), transferId, body.shortCloseReason);
  }

  private caller(request: TenantContextRequest): TransferCaller {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) throw new UnauthorizedException('Unauthorized');
    return { tenantId: ctx.tenantId, userId: ctx.userId, context: ctx };
  }
}
