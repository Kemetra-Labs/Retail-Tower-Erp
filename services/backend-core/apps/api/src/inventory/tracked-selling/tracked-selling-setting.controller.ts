/**
 * The tenant's tracked-selling switch — Jira RT-451 S2 runtime
 * (`inventory/inventory.yaml` 1.12.0-draft; owner decisions OD-T1..OD-T7,
 * RT-451 comments 16215, 16216, 16217):
 *
 *   GET  /api/inventory/v1/settings/tracked-selling  → getTrackedSellingSetting
 *   PUT  /api/inventory/v1/settings/tracked-selling  → setTrackedSellingSetting
 *
 * Auth: the cookieAuth operator surface. `RolesGuard` admits owner,
 * tenant_admin and store_manager to the read (the service gives a
 * store_manager the on/off value only, OD-T6) and owner / tenant_admin to the
 * write; any other role is a 403. Authentication (401) and role (403) are
 * checked first, as for `posListTrackedLots`; then, while the deployment gate
 * `POS_TRACKED_SELLING_ENABLED` is off, both operations answer the
 * non-disclosing 404 and touch nothing.
 *
 * The body is a strict Zod DTO of the contract's `SetTrackedSellingSettingCommand`:
 * tenant and actor are never accepted from it (FR-052). A PUT of the whole
 * value is naturally idempotent, so it takes no Idempotency-Key. The service
 * writes the audit row in the change's transaction (no `@Auditable`).
 */
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { DashboardAuthGuard } from '../../auth/dashboard-auth.guard';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { isTrackedSellingEnabled } from '../../catalog/sales/tracked-lines/tracked-selling-gate';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TenantContextGuard } from '../../context/tenant-context.guard';
import type { TenantContextRequest } from '../../context/types';
import {
  TrackedSellingSettingService,
  type TrackedSellingCaller,
  type TrackedSellingSettingBody,
} from './tracked-selling-setting.service';

/** Contract `SetTrackedSellingSettingCommand`. */
const SetTrackedSellingSchema = z.object({ enabled: z.boolean() }).strict();
type SetTrackedSellingDto = z.infer<typeof SetTrackedSellingSchema>;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class TrackedSellingSettingController {
  constructor(private readonly setting: TrackedSellingSettingService) {}

  /** The tenant's tracked-selling switch and its preconditions (OD-T6: on/off only for a store_manager). */
  @Get('api/inventory/v1/settings/tracked-selling')
  @Roles('owner', 'tenant_admin', 'store_manager', { denyAs: 403 })
  async getTrackedSellingSetting(@Req() request: TenantContextRequest): Promise<TrackedSellingSettingBody> {
    const caller = gatedCaller(request);
    return await this.setting.getSetting(caller);
  }

  /** Switch tracked selling on (preconditions must hold) or off (always accepted). */
  @Put('api/inventory/v1/settings/tracked-selling')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async setTrackedSellingSetting(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(SetTrackedSellingSchema)) body: SetTrackedSellingDto,
  ): Promise<TrackedSellingSettingBody> {
    const caller = gatedCaller(request);
    return await this.setting.setSetting(caller, body.enabled);
  }
}

/**
 * The authenticated, tenant-bound caller; then the deployment gate's
 * non-disclosing 404. The guards have already answered 401 and 403.
 */
function gatedCaller(request: TenantContextRequest): TrackedSellingCaller {
  const tenantId = request.context?.tenantId ?? null;
  const userId = request.context?.userId ?? null;
  if (tenantId === null || userId === null) throw new UnauthorizedException('Unauthorized');
  if (!isTrackedSellingEnabled()) throw new NotFoundException('not_found');
  return { tenantId, userId, isPlatformAdmin: request.context?.isPlatformAdmin === true };
}
