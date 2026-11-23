/**
 * RT-1577 (RT-1511 S2) — `posGetStoreAvailability`.
 * Contract: `packages/contracts/openapi/inventory/pos-availability.yaml`.
 *
 *   GET /api/pos/v1/inventory/availability → the store's Available-to-Sell snapshot, one page per call.
 *
 * Auth and scope follow the catalogue read-down (`catalog/read-down/read-down.controller.ts`) and the safety feed:
 * `PosDeviceAuthGuard` authenticates the terminal by its pairing token alone and resolves its (tenant, store) from the
 * device row; nothing in the query is authority. A supplied `branch_id` that is not the device's store, and a malformed or
 * foreign cursor, are a non-disclosing 404. READ-ONLY: GET only. No build-identity report (`@ReportsBuildIdentity`): that
 * set of operations is closed by `pos-terminal-pairing.openapi.yaml`.
 *
 * Audit: the `@Auditable` read row names the reading device (`device_id`).
 */
import { Controller, Get, NotFoundException, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { annotateAudit, Auditable } from '../../audit';
import { DeviceBearer, PosDeviceAuthGuard } from '../../auth';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { TenantContextRequest } from '../../context';
import { AvailabilityCursorError } from './pos-availability.cursor';
import { PosAvailabilityService, type StoreAvailabilityPage } from './pos-availability.service';

/** `branch_id`: optional; checked against the device's store, never trusted. */
const BranchIdSchema = z.string().uuid().optional();
/** `cursor`: opaque; the service decodes and scope-checks it. */
const CursorSchema = z.string().min(1).optional();
/** `limit`: 1-1000 (contract `Limit`; the default is the service's). */
const LimitSchema = z.coerce.number().int().min(1).max(1000).optional();

@Controller()
export class PosAvailabilityController {
  constructor(private readonly availability: PosAvailabilityService) {}

  @Get('api/pos/v1/inventory/availability')
  @DeviceBearer()
  @UseGuards(PosDeviceAuthGuard)
  @Auditable('inventory_availability.snapshot.read')
  async getStoreAvailability(
    @Req() request: TenantContextRequest,
    @Query('branch_id', new ZodValidationPipe(BranchIdSchema)) branchId: string | undefined,
    @Query('cursor', new ZodValidationPipe(CursorSchema)) cursor: string | undefined,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number | undefined,
  ): Promise<StoreAvailabilityPage> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) throw new UnauthorizedException('Unauthorized');
    if (request.posDeviceId !== undefined) annotateAudit(request, { device_id: request.posDeviceId });
    // The read is store-scoped: a POS principal with no resolved store cannot read availability.
    if (ctx.storeId === null) throw new UnauthorizedException('store_context_required');
    // A supplied branch_id MUST be the device's store; a mismatch reveals nothing (non-disclosing 404).
    if (branchId !== undefined && branchId.toLowerCase() !== ctx.storeId.toLowerCase()) {
      throw new NotFoundException('not_found');
    }
    try {
      return await this.availability.getSnapshot(ctx.tenantId, ctx.storeId, { limit, cursor: cursor ?? null });
    } catch (err) {
      if (err instanceof AvailabilityCursorError) throw new NotFoundException('not_found');
      throw err;
    }
  }
}
