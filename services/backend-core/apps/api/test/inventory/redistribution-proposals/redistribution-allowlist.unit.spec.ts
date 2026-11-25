/**
 * Jira RT-1600 — the two dark-launch allowlists (`REDISTRIBUTION_SHADOW_TENANT_ALLOWLIST`,
 * `REDISTRIBUTION_LIVE_TENANT_ALLOWLIST`) and the guard that applies them before the idempotency interceptor.
 */
import 'reflect-metadata';

import { NotFoundException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  isLiveListed,
  isShadowEnabled,
  resolveRedistributionAllowlist,
} from '../../../src/inventory/redistribution-proposals/redistribution-allowlist.config';
import { RedistributionPhaseGuard, RequiresLivePhase } from '../../../src/inventory/redistribution-proposals/redistribution-phase.guard';

const SHADOW = '0190f5a2-3b4c-7d8e-9f01-0000000000a1';
const LIVE = '0190F5A2-3B4C-7D8E-9F01-0000000000A2';
const OTHER = '0190f5a2-3b4c-7d8e-9f01-0000000000a3';

describe('resolveRedistributionAllowlist', () => {
  it('is empty when unset or blank: nobody', () => {
    for (const env of [{}, { REDISTRIBUTION_SHADOW_TENANT_ALLOWLIST: '', REDISTRIBUTION_LIVE_TENANT_ALLOWLIST: ' , ' }]) {
      const c = resolveRedistributionAllowlist(env);
      expect([c.shadow.size, c.live.size, c.ignoredCount]).toEqual([0, 0, 0]);
    }
  });

  it('lower-cases UUIDs, trims entries, ignores and counts non-UUIDs, and makes live imply shadow', () => {
    const c = resolveRedistributionAllowlist({
      REDISTRIBUTION_SHADOW_TENANT_ALLOWLIST: ` ${SHADOW} ,not-a-tenant,,`,
      REDISTRIBUTION_LIVE_TENANT_ALLOWLIST: `${LIVE},*`,
    });
    expect([...c.shadow].sort()).toEqual([SHADOW, LIVE.toLowerCase()].sort());
    expect([...c.live]).toEqual([LIVE.toLowerCase()]);
    expect(c.ignoredCount).toBe(2);
    expect(isShadowEnabled(c, SHADOW.toUpperCase())).toBe(true);
    expect(isShadowEnabled(c, LIVE)).toBe(true);
    expect(isLiveListed(c, SHADOW)).toBe(false);
    expect(isLiveListed(c, LIVE.toLowerCase())).toBe(true);
    expect(isShadowEnabled(c, OTHER)).toBe(false);
  });
});

class Routes {
  read(): void {}
  @RequiresLivePhase()
  accept(): void {}
}

describe('RedistributionPhaseGuard', () => {
  const config = resolveRedistributionAllowlist({
    REDISTRIBUTION_SHADOW_TENANT_ALLOWLIST: SHADOW,
    REDISTRIBUTION_LIVE_TENANT_ALLOWLIST: LIVE,
  });
  const guard = new RedistributionPhaseGuard(new Reflector(), config);
  const ctx = (tenantId: string | null | undefined, route: 'read' | 'accept'): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ context: tenantId === undefined ? undefined : { tenantId } }) }),
      getHandler: () => Routes.prototype[route],
    }) as unknown as ExecutionContext;

  it('admits a shadow or live tenant to the shadow routes', () => {
    expect(guard.canActivate(ctx(SHADOW, 'read'))).toBe(true);
    expect(guard.canActivate(ctx(LIVE, 'read'))).toBe(true);
  });

  it('answers a tenant on neither list with the non-disclosing 404, on every route', () => {
    expect(() => guard.canActivate(ctx(OTHER, 'read'))).toThrow(NotFoundException);
    expect(() => guard.canActivate(ctx(OTHER, 'accept'))).toThrow(NotFoundException);
  });

  it('admits only a live tenant to accept: a shadow-only tenant gets the same 404', () => {
    expect(guard.canActivate(ctx(LIVE, 'accept'))).toBe(true);
    expect(() => guard.canActivate(ctx(SHADOW, 'accept'))).toThrow(NotFoundException);
  });

  it('refuses a request without a tenant (401)', () => {
    expect(() => guard.canActivate(ctx(undefined, 'read'))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx(null, 'read'))).toThrow(UnauthorizedException);
  });
});
