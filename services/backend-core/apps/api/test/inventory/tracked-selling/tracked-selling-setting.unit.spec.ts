/**
 * Jira RT-451 S2 — Docker-free unit tests of the tracked-selling switch:
 *   - the controller answers the deployment gate's non-disclosing 404 after
 *     authentication, never reaching the service while the gate is off, and
 *     hands the service the caller from the context only;
 *   - the routes carry the contract's roles (read: owner, tenant_admin,
 *     store_manager; write: owner, tenant_admin);
 *   - the Q13 precondition checks fail closed, in the contract's order.
 */
import 'reflect-metadata';

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { TRACKED_SELLING_GATE } from '../../../src/catalog/sales/tracked-lines/tracked-selling-gate';
import type { TenantContextRequest } from '../../../src/context/types';
import {
  TRACKED_SELLING_PRECONDITIONS,
  TrackedSellingPreconditions,
} from '../../../src/inventory/tracked-selling/tracked-selling-preconditions';
import { TrackedSellingSettingController } from '../../../src/inventory/tracked-selling/tracked-selling-setting.controller';
import type {
  TrackedSellingCaller,
  TrackedSellingSettingService,
} from '../../../src/inventory/tracked-selling/tracked-selling-setting.service';

const TENANT = '0a000000-0000-7000-8000-000000451201';
const USER = '0a000000-0000-7000-8000-000000451202';
const BODY = { enabled: false, changedAt: null, changedBy: null, preconditionsMet: false, unmetPreconditions: [] };

function request(context: Partial<NonNullable<TenantContextRequest['context']>> | undefined): TenantContextRequest {
  return {
    context:
      context === undefined
        ? undefined
        : { userId: USER, tenantId: TENANT, storeId: null, isPlatformAdmin: false, source: 'session', ...context },
  } as unknown as TenantContextRequest;
}

describe('TrackedSellingSettingController', () => {
  const calls: Array<[string, TrackedSellingCaller, boolean?]> = [];
  const service = {
    getSetting: async (caller: TrackedSellingCaller) => {
      calls.push(['get', caller]);
      return BODY;
    },
    setSetting: async (caller: TrackedSellingCaller, enabled: boolean) => {
      calls.push(['set', caller, enabled]);
      return { ...BODY, enabled };
    },
  } as unknown as TrackedSellingSettingService;
  const controller = new TrackedSellingSettingController(service);

  beforeEach(() => {
    calls.length = 0;
    delete process.env[TRACKED_SELLING_GATE];
  });
  afterAll(() => {
    delete process.env[TRACKED_SELLING_GATE];
  });

  it('answers the non-disclosing 404 while the gate is off and never reaches the service', async () => {
    await expect(controller.getTrackedSellingSetting(request({}))).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.setTrackedSellingSetting(request({}), { enabled: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(calls).toEqual([]);
  });

  it('is 401 before the gate for a context without a tenant or a user', async () => {
    for (const ctx of [undefined, { tenantId: null }, { userId: null }]) {
      await expect(controller.getTrackedSellingSetting(request(ctx))).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(calls).toEqual([]);
  });

  it('with the gate on, hands the service the caller from the context only', async () => {
    process.env[TRACKED_SELLING_GATE] = 'true';
    expect(await controller.getTrackedSellingSetting(request({ isPlatformAdmin: true }))).toEqual(BODY);
    expect((await controller.setTrackedSellingSetting(request({}), { enabled: true })).enabled).toBe(true);
    expect(calls).toEqual([
      ['get', { tenantId: TENANT, userId: USER, isPlatformAdmin: true }],
      ['set', { tenantId: TENANT, userId: USER, isPlatformAdmin: false }, true],
    ]);
  });

  it('declares the contract roles on both routes', () => {
    const roles = (name: 'getTrackedSellingSetting' | 'setTrackedSellingSetting') => {
      const keys = Reflect.getMetadataKeys(TrackedSellingSettingController.prototype[name]);
      const values = keys.map((k) => Reflect.getMetadata(k, TrackedSellingSettingController.prototype[name]));
      return JSON.stringify(values);
    };
    expect(roles('getTrackedSellingSetting')).toContain('store_manager');
    expect(roles('setTrackedSellingSetting')).not.toContain('store_manager');
    for (const name of ['getTrackedSellingSetting', 'setTrackedSellingSetting'] as const) {
      expect(roles(name)).toContain('owner');
      expect(roles(name)).toContain('tenant_admin');
    }
  });
});

describe('TrackedSellingPreconditions (fail closed)', () => {
  const client = (activated: boolean | undefined) =>
    ({
      query: async () => ({ rows: activated === undefined ? [] : [{ active: activated }] }),
    }) as unknown as PoolClient;

  it('lists every unconfirmable precondition as unmet, in the contract order', async () => {
    const unmet = await new TrackedSellingPreconditions().unmet(client(true), TENANT);
    expect(unmet).toEqual([
      'erp_tracking_import',
      'erp_batch_posting_verified',
      'identity_anchor',
      'tracking_grain_reconciliation',
    ]);
    expect(TRACKED_SELLING_PRECONDITIONS.filter((p) => unmet.includes(p))).toEqual(unmet);
  });

  it('reads sale_effects_active as unmet without an activation or without a settings row', async () => {
    for (const activated of [false, undefined]) {
      expect((await new TrackedSellingPreconditions().unmet(client(activated), TENANT))[0]).toBe('sale_effects_active');
    }
  });
});
