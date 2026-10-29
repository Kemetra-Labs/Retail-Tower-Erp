/**
 * InventorySafetyFeedController — Jira RT-449 PR 2 (RT-50 G7-7; ruling H5,
 * RT-449 comment 13434).
 * Contract: `packages/contracts/openapi/inventory/inventory-safety-feed.yaml`.
 *
 *   GET /api/pos/v1/inventory-safety/snapshot → posGetInventorySafetySnapshot
 *   GET /api/pos/v1/inventory-safety/deltas   → posGetInventorySafetyDeltas
 *
 * Auth and scope follow the catalogue read-down
 * (`catalog/read-down/read-down.controller.ts`): `PosDeviceAuthGuard`
 * authenticates the terminal by its pairing token alone and resolves its
 * (tenant, store) from the device row; nothing in the query is authority. A
 * supplied `branch_id` that is not the device's store, and a malformed or
 * foreign page token, are a non-disclosing 404. The content is tenant-level
 * (H5), so the store only scopes the caller.
 *
 * Audit: `@Auditable` read rows name the reading device (`device_id`). No
 * build-identity report (`@ReportsBuildIdentity`): that set of operations is
 * closed by `pos-terminal-pairing.openapi.yaml`.
 */
import {
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { annotateAudit, Auditable } from '../../audit/auditable.decorator';
import { PosDeviceAuthGuard } from '../../auth/pos-device-auth.guard';
import { DeviceBearer } from '../../auth/route-auth';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { TenantContextRequest } from '../../context/types';
import { SafetyFeedCursorError } from './inventory-safety-feed.cursor';
import {
  InventorySafetyFeedService,
  type InventorySafetyDeltaPage,
  type InventorySafetySnapshotPage,
} from './inventory-safety-feed.service';

/** `branch_id`: optional; checked against the device's store, never trusted. */
const BranchIdSchema = z.string().uuid().optional();
/** `page_token`: opaque; the service decodes and scope-checks it. */
const PageTokenSchema = z.string().min(1).optional();
/** `limit`: 1–1000 (contract `Limit`; the default is the service's). */
const LimitSchema = z.coerce.number().int().min(1).max(1000).optional();
/** `since`: a revision, 0 or more (contract `FeedRevision`). */
const SinceSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);

/** The device's resolved (tenant, store); the controller-level refusals in contract order. */
function deviceScope(request: TenantContextRequest, branchId: string | undefined): {
  tenantId: string;
  storeId: string;
} {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException('Unauthorized');
  if (request.posDeviceId !== undefined) annotateAudit(request, { device_id: request.posDeviceId });
  if (ctx.storeId === null) throw new UnauthorizedException('store_context_required');
  if (branchId !== undefined && branchId.toLowerCase() !== ctx.storeId.toLowerCase()) {
    throw new NotFoundException('not_found');
  }
  return { tenantId: ctx.tenantId, storeId: ctx.storeId };
}

@Controller()
export class InventorySafetyFeedController {
  constructor(private readonly feed: InventorySafetyFeedService) {}

  @Get('api/pos/v1/inventory-safety/snapshot')
  @DeviceBearer()
  @UseGuards(PosDeviceAuthGuard)
  @Auditable('inventory_safety.snapshot.read')
  async getSnapshot(
    @Req() request: TenantContextRequest,
    @Query('branch_id', new ZodValidationPipe(BranchIdSchema)) branchId: string | undefined,
    @Query('page_token', new ZodValidationPipe(PageTokenSchema)) pageToken: string | undefined,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number | undefined,
  ): Promise<InventorySafetySnapshotPage> {
    const { tenantId, storeId } = deviceScope(request, branchId);
    try {
      return await this.feed.getSnapshot(tenantId, storeId, { limit, pageToken: pageToken ?? null });
    } catch (err) {
      if (err instanceof SafetyFeedCursorError) throw new NotFoundException('not_found');
      throw err;
    }
  }

  @Get('api/pos/v1/inventory-safety/deltas')
  @DeviceBearer()
  @UseGuards(PosDeviceAuthGuard)
  @Auditable('inventory_safety.deltas.read')
  async getDeltas(
    @Req() request: TenantContextRequest,
    @Query('since', new ZodValidationPipe(SinceSchema)) since: number,
    @Query('branch_id', new ZodValidationPipe(BranchIdSchema)) branchId: string | undefined,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number | undefined,
  ): Promise<InventorySafetyDeltaPage> {
    const { tenantId } = deviceScope(request, branchId);
    const result = await this.feed.getDeltas(tenantId, since, { limit });
    if (result.kind === 'snapshot_required') {
      throw new ConflictException({ code: 'snapshot_required', message: 'snapshot_required' });
    }
    return result.page;
  }
}
