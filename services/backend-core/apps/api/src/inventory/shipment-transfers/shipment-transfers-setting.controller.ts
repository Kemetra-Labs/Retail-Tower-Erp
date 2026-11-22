/**
 * The tenant's shipment-Transfer activation switch — Jira RT-1517 (RT-291 Gate 5):
 *
 *   GET  /api/inventory/v1/settings/shipment-transfers  -> getShipmentTransfersSetting
 *   PUT  /api/inventory/v1/settings/shipment-transfers  -> setShipmentTransfersSetting
 *
 * The HTTP surface of the RT-1513 `ShipmentTransferActivationService`, which owns the readiness check, the in-flight
 * refusal, the settings lock and the audit row. Shaped like the Count Sessions switch (owner decision, RT-1517).
 *
 * Auth: the cookieAuth operator surface. `RolesGuard` admits owner and tenant_admin to both the read and the write (the
 * service checks the same roles again inside the tenant transaction); any other role is a 403. The body is a strict Zod
 * DTO of `SetShipmentTransfersSettingCommand`: tenant and actor are never accepted from it. A PUT of the whole value is
 * naturally idempotent, so it takes no Idempotency-Key.
 */
import { Body, Controller, Get, Put, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { DashboardAuthGuard, Roles, RolesGuard } from '../../auth';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TenantContextGuard, type TenantContextRequest } from '../../context';
import {
  ShipmentTransferActivationService,
  type TransferActivationCaller,
  type TransferActivationState,
  type UnmetTransferReadiness,
} from './shipment-transfer-activation.service';

/** Contract `SetShipmentTransfersSettingCommand`. */
export const SetShipmentTransfersSettingSchema = z.object({ enabled: z.boolean() }).strict();
type SetShipmentTransfersSettingDto = z.infer<typeof SetShipmentTransfersSettingSchema>;

/** Contract `ShipmentTransfersSetting`. */
interface ShipmentTransfersSettingBody {
  readonly enabled: boolean;
  readonly changedAt: string | null;
  readonly changedBy: string | null;
  readonly delayedTransferThresholdDays: number;
  readonly readinessMet: boolean;
  readonly unmetReadiness: UnmetTransferReadiness[];
}

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class ShipmentTransfersSettingController {
  constructor(private readonly activation: ShipmentTransferActivationService) {}

  /** The tenant's activation switch and its readiness. */
  @Get('api/inventory/v1/settings/shipment-transfers')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async getShipmentTransfersSetting(@Req() request: TenantContextRequest): Promise<ShipmentTransfersSettingBody> {
    return toBody(await this.activation.getState(caller(request)));
  }

  /** Switch shipment Transfers on (readiness must hold) or off (refused while a Transfer is in flight). */
  @Put('api/inventory/v1/settings/shipment-transfers')
  @Roles('owner', 'tenant_admin', { denyAs: 403 })
  async setShipmentTransfersSetting(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(SetShipmentTransfersSettingSchema)) body: SetShipmentTransfersSettingDto,
  ): Promise<ShipmentTransfersSettingBody> {
    return toBody(await this.activation.setEnabled(caller(request), body.enabled));
  }
}

function toBody(state: TransferActivationState): ShipmentTransfersSettingBody {
  return {
    enabled: state.enabled,
    changedAt: state.changedAt,
    changedBy: state.changedBy,
    delayedTransferThresholdDays: state.delayedTransferThresholdDays,
    readinessMet: state.unmetReadiness.length === 0,
    unmetReadiness: state.unmetReadiness,
  };
}

function caller(request: TenantContextRequest): TransferActivationCaller {
  const tenantId = request.context?.tenantId ?? null;
  const userId = request.context?.userId ?? null;
  if (tenantId === null || userId === null) throw new UnauthorizedException('Unauthorized');
  return { tenantId, userId, isPlatformAdmin: request.context?.isPlatformAdmin === true };
}
