/**
 * SaleLineFindingsController — Jira RT-451 slice S3 (RT-455 OD-2; RT-50 G7-9
 * rows 2 and 3).
 *
 *   GET /api/inventory/v1/safety/sale-line-findings → listSaleLineFindings
 *
 * The cookieAuth operator surface, as `listInventorySafetyFindings`: owner,
 * tenant_admin and store_manager (the service narrows a store_manager to its
 * own stores); any other role is a 403 (denyAs 403: the active tenant is the
 * caller's own, so nothing is disclosed). Console rate-limit class
 * `expensiveRead`. A read: no audit row, as the sibling findings read.
 */
import { Controller, Get, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { SALE_LINE_FINDING_KINDS } from '@data-pulse-2/db';
import { z } from 'zod';

import { DashboardAuthGuard } from '../../auth/dashboard-auth.guard';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ConsoleRateLimit } from '../../console-rate-limit/console-rate-limit.decorator';
import { TenantContextGuard } from '../../context/tenant-context.guard';
import type { ResolvedContext, TenantContextRequest } from '../../context/types';
import { SaleLineFindingsService, type SaleLineFindingListBody } from './sale-line-findings.service';

/** Query of `listSaleLineFindings` (unknown parameters are ignored, as on the other lists). */
const ListSaleLineFindingsQuerySchema = z.object({
  kind: z.enum(SALE_LINE_FINDING_KINDS).optional(),
  storeId: z.string().uuid().optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
type ListSaleLineFindingsQuery = z.infer<typeof ListSaleLineFindingsQuerySchema>;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class SaleLineFindingsController {
  constructor(private readonly findings: SaleLineFindingsService) {}

  /** The tenant's recorded sale-line findings in the caller's store scope, newest first. */
  @Get('api/inventory/v1/safety/sale-line-findings')
  @Roles('owner', 'tenant_admin', 'store_manager', { denyAs: 403 })
  @ConsoleRateLimit('expensiveRead')
  async listSaleLineFindings(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListSaleLineFindingsQuerySchema)) query: ListSaleLineFindingsQuery,
  ): Promise<SaleLineFindingListBody> {
    const tenantId = request.context?.tenantId ?? null;
    if (tenantId === null || (request.context?.userId ?? null) === null) {
      throw new UnauthorizedException('Unauthorized');
    }
    return await this.findings.listFindings({
      tenantId,
      context: request.context as ResolvedContext,
      ...query,
    });
  }
}
