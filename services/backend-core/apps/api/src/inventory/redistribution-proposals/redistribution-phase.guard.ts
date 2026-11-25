/**
 * RT-1600 — the dark-launch gate of the redistribution proposal routes, as a guard. It runs after
 * `DashboardAuthGuard`, `TenantContextGuard` and `RolesGuard` (so the session tenant is known and a role outside owner
 * and tenant_admin already had its non-disclosing 404), and BEFORE the idempotency interceptor, so a refusal claims no
 * key and writes nothing.
 *
 * A tenant on neither allowlist gets the same non-disclosing 404 as an unknown proposal (RT-1599 WHO; unlike Pricing's
 * 409, the feature's existence is not disclosed). A route marked `@RequiresLivePhase()` (accept) also needs the live
 * list; the W3 shipment-transfers switch is checked by the service in the command's own transaction.
 */
import {
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { TenantContextRequest } from '../../context';
import { REDISTRIBUTION_ALLOWLIST, isLiveListed, isShadowEnabled, type RedistributionAllowlist } from './redistribution-allowlist.config';

const LIVE_PHASE_KEY = 'dp2:redistribution:live-phase';

/** Marks a route that only the live phase may call (accept). */
export const RequiresLivePhase = (): MethodDecorator => SetMetadata(LIVE_PHASE_KEY, true);

@Injectable()
export class RedistributionPhaseGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDISTRIBUTION_ALLOWLIST) private readonly allowlist: RedistributionAllowlist,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const tenantId = context.switchToHttp().getRequest<TenantContextRequest>().context?.tenantId ?? null;
    if (tenantId === null) throw new UnauthorizedException('Unauthorized');
    const live = this.reflector.get<boolean | undefined>(LIVE_PHASE_KEY, context.getHandler()) === true;
    const allowed = live ? isLiveListed(this.allowlist, tenantId) : isShadowEnabled(this.allowlist, tenantId);
    if (!allowed) throw new NotFoundException('Not Found');
    return true;
  }
}
