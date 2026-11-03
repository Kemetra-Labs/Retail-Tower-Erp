/**
 * TrackingIdentitiesController — RT-448 (RT-50 Inventory Gate 7, rule G7-2).
 *
 *   GET /api/inventory/v1/products/{productId}/tracking-identities
 *     → listTrackingIdentities (packages/contracts/openapi/inventory/inventory.yaml)
 *
 * RT-1081 (RT-455 II-5 / II-2), the same family rule:
 *
 *   GET /api/inventory/v1/tracking-identities/{identityId}            → getTrackingIdentity
 *   GET /api/inventory/v1/tracking-identities/{identityId}/positions  → getTrackingIdentityPositions
 *
 * Read-only: the tenant's batches / serials of one product. Identities are
 * tenant-wide, not store-scoped, so this route does not use the store-scoped
 * authorization of `InventoryController`; it is owner / tenant-admin only
 * (`RolesGuard` + `@Roles`, denyAs 404: any other role, and a product outside
 * the session tenant, is a non-disclosing 404, §II/§XII).
 *
 * A separate controller keeps `RolesGuard` (and its MembershipRepository
 * dependency) off the store-scoped inventory routes.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { DashboardAuthGuard } from '../auth/dashboard-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ConsoleRateLimit } from '../console-rate-limit/console-rate-limit.decorator';
import { TenantContextGuard } from '../context/tenant-context.guard';
import type { ResolvedContext, TenantContextRequest } from '../context/types';
import {
  InventoryService,
  type TrackingIdentityBody,
  type TrackingIdentityListBody,
} from './inventory.service';
import {
  TrackingIdentityReadsService,
  type TrackingIdentityPositionsBody,
} from './tracking-identity-reads.service';
import {
  TrackingIdentityCursorError,
  decodeTrackingIdentityCursor,
  type TrackingIdentityCursor,
} from './tracking-identity.cursor';

const LimitSchema = z.coerce.number().int().min(1).max(200).optional();
const CursorSchema = z.string().min(1).max(1024).optional();
const UuidSchema = z.string().uuid();

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class TrackingIdentitiesController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly identityReads: TrackingIdentityReadsService,
  ) {}

  @Get('api/inventory/v1/products/:productId/tracking-identities')
  @UseGuards(RolesGuard)
  @Roles('owner', 'tenant_admin')
  async listTrackingIdentities(
    @Req() request: TenantContextRequest,
    @Param('productId', new ZodValidationPipe(z.string().uuid())) productId: string,
    @Query('limit', new ZodValidationPipe(LimitSchema)) limit: number | undefined,
    @Query('cursor', new ZodValidationPipe(CursorSchema)) cursor: string | undefined,
  ): Promise<TrackingIdentityListBody> {
    const tenantId = request.context?.tenantId;
    if (!tenantId) throw new UnauthorizedException('Unauthorized');
    return await this.inventoryService.listTrackingIdentities({
      tenantId,
      productId,
      limit,
      cursor: cursor === undefined ? undefined : decodeCursor(cursor, productId),
    });
  }

  /** RT-1081 II-5: one identity of the tenant. */
  @Get('api/inventory/v1/tracking-identities/:identityId')
  @UseGuards(RolesGuard)
  @Roles('owner', 'tenant_admin')
  async getTrackingIdentity(
    @Req() request: TenantContextRequest,
    @Param('identityId', new ZodValidationPipe(UuidSchema)) identityId: string,
  ): Promise<TrackingIdentityBody> {
    return await this.identityReads.getIdentity(tenantOf(request), identityId);
  }

  /** RT-1081 II-2 (OD-6): one identity's positions per store, summed over locations. */
  @Get('api/inventory/v1/tracking-identities/:identityId/positions')
  @UseGuards(RolesGuard)
  @Roles('owner', 'tenant_admin')
  @ConsoleRateLimit('expensiveRead')
  async getTrackingIdentityPositions(
    @Req() request: TenantContextRequest,
    @Param('identityId', new ZodValidationPipe(UuidSchema)) identityId: string,
  ): Promise<TrackingIdentityPositionsBody> {
    return await this.identityReads.getPositions({
      tenantId: tenantOf(request),
      identityId,
      context: request.context as ResolvedContext,
    });
  }
}

/** The session tenant; a request without one is a 401. */
function tenantOf(request: TenantContextRequest): string {
  const tenantId = request.context?.tenantId;
  if (!tenantId) throw new UnauthorizedException('Unauthorized');
  return tenantId;
}

/** A malformed cursor, or one issued for another product, is a 400. */
function decodeCursor(token: string, productId: string): TrackingIdentityCursor {
  try {
    return decodeTrackingIdentityCursor(token, productId);
  } catch (err: unknown) {
    if (err instanceof TrackingIdentityCursorError) {
      throw new BadRequestException('Invalid cursor');
    }
    throw err;
  }
}
