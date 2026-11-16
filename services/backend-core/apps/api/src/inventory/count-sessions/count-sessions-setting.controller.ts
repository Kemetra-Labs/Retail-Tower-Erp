/**
 * The tenant's Count Session activation switch — Jira RT-1423 (RT-292 Gate 6, G6-7):
 *
 *   GET  /api/inventory/v1/settings/count-sessions  -> getCountSessionsSetting
 *   PUT  /api/inventory/v1/settings/count-sessions  -> setCountSessionsSetting
 *
 * Auth: the cookieAuth operator surface. `RolesGuard` admits owner, tenant_admin and store_manager to the read
 * (the service gives a store_manager the on/off value only) and owner / tenant_admin to the write; any other
 * role is a 403. The body is a strict Zod DTO of `SetCountSessionsSettingCommand`: tenant and actor are never
 * accepted from it. A PUT of the whole value is naturally idempotent, so it takes no Idempotency-Key. The
 * service writes the audit row in the change's transaction.
 */
import { Body, Controller, Get, Put, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { DashboardAuthGuard } from '../../auth/dashboard-auth.guard';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TenantContextGuard } from '../../context/tenant-context.guard';
import type { TenantContextRequest } from '../../context/types';
import {
  CountSessionsSettingService,
  type CountSessionsCaller,
  type CountSessionsSettingBody,
} from './count-sessions-setting.service';

/** Contract `SetCountSessionsSettingCommand`. */
const SetCountSessionsSchema = z.object({ enabled: z.boolean() }).strict();
type SetCountSessionsDto = z.infer<typeof SetCountSessionsSchema>;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class CountSessionsSettingController {
  constructor(private readonly setting: CountSessionsSettingService) {}

  /** The tenant's activation switch and its readiness (a store_manager reads on/off only). */
  @Get('api/inventory/v1/settings/count-sessions')
  @Roles('owner', 'tenant_admin', 'store_manager', { denyAs: 403 })
  async getCountSessionsSetting(@Req() request: TenantContextRequest): Promise<CountSessionsSettingBody> {
    return await this.setting.getSetting(caller(request));
  }

  /** Switch Count Sessions on (readiness must hold) or off (refused while a session is open). */
  @Put('api/inventory/v1/settings/count-sessions')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async setCountSessionsSetting(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(SetCountSessionsSchema)) body: SetCountSessionsDto,
  ): Promise<CountSessionsSettingBody> {
    return await this.setting.setSetting(caller(request), body.enabled);
  }
}

function caller(request: TenantContextRequest): CountSessionsCaller {
  const tenantId = request.context?.tenantId ?? null;
  const userId = request.context?.userId ?? null;
  if (tenantId === null || userId === null) throw new UnauthorizedException('Unauthorized');
  return { tenantId, userId, isPlatformAdmin: request.context?.isPlatformAdmin === true };
}
