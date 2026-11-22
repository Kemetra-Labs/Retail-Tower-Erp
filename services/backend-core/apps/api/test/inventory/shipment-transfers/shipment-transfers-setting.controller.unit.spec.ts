/**
 * Jira RT-1517 — the wiring of the tenant's shipment-Transfer activation switch (`ShipmentTransfersSettingController`),
 * without a database. The switch's behaviour (readiness, in-flight refusal, audit, lock) is the RT-1513
 * `ShipmentTransferActivationService`, covered over real Postgres by `shipment-transfers.db.spec.ts`.
 *
 * Pins: the two contract paths and methods, the guard order, the owner / tenant_admin role gate, no Idempotency-Key on the
 * whole-value PUT, the strict body, the 401 on a missing context, and the response shape (`readinessMet` derived from
 * `unmetReadiness`).
 */
import 'reflect-metadata';

import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { UnauthorizedException } from '@nestjs/common';

import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { ROLES_METADATA_KEY } from '../../../src/auth/roles.decorator';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import { IDEMPOTENT_POLICY_KEY } from '../../../src/idempotency/idempotent.decorator';
import type { TransferActivationState } from '../../../src/inventory/shipment-transfers/shipment-transfer-activation.service';
import {
  SetShipmentTransfersSettingSchema,
  ShipmentTransfersSettingController,
} from '../../../src/inventory/shipment-transfers/shipment-transfers-setting.controller';

const PATH = 'api/inventory/v1/settings/shipment-transfers';
const GET = 0;
const PUT = 2;
const TENANT = '0198b000-0000-7000-8000-000000000001';
const USER = '0198b000-0000-7000-8000-000000000002';

const handler = (name: string): object =>
  Object.getOwnPropertyDescriptor(ShipmentTransfersSettingController.prototype, name)?.value as object;

const state = (over: Partial<TransferActivationState> = {}): TransferActivationState => ({
  enabled: false,
  changedAt: null,
  changedBy: null,
  delayedTransferThresholdDays: 3,
  unmetReadiness: [],
  ...over,
});

function controllerWith(result: TransferActivationState) {
  const calls: { method: string; args: unknown[] }[] = [];
  const service = {
    getState: async (...args: unknown[]) => (calls.push({ method: 'getState', args }), result),
    setEnabled: async (...args: unknown[]) => (calls.push({ method: 'setEnabled', args }), result),
  };
  return { controller: new ShipmentTransfersSettingController(service as never), calls };
}

const request = (context: unknown) => ({ context }) as never;
const session = { tenantId: TENANT, userId: USER, isPlatformAdmin: false };

describe('ShipmentTransfersSettingController wiring', () => {
  it('serves exactly the two contract operations, by their operationId', () => {
    const own = Object.getOwnPropertyNames(ShipmentTransfersSettingController.prototype).filter((n) => n !== 'constructor');
    expect(own.sort()).toEqual(['getShipmentTransfersSetting', 'setShipmentTransfersSetting']);
  });

  it.each([
    ['getShipmentTransfersSetting', GET],
    ['setShipmentTransfersSetting', PUT],
  ])('%s answers on its contract method and path', (name, method) => {
    expect(Reflect.getMetadata(METHOD_METADATA, handler(name))).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler(name))).toBe(PATH);
  });

  it('authenticates the human session, then the tenant context, then the role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ShipmentTransfersSettingController)).toEqual([
      DashboardAuthGuard,
      TenantContextGuard,
      RolesGuard,
    ]);
  });

  it.each(['getShipmentTransfersSetting', 'setShipmentTransfersSetting'])(
    '%s admits owner and tenant_admin only, and answers a wrong role 403',
    (name) => {
      expect(Reflect.getMetadata(ROLES_METADATA_KEY, handler(name))).toMatchObject({
        any: ['owner', 'tenant_admin'],
        denyAs: 403,
      });
    },
  );

  it('takes no Idempotency-Key: the PUT of the whole value is naturally idempotent', () => {
    for (const name of ['getShipmentTransfersSetting', 'setShipmentTransfersSetting']) {
      expect(Reflect.getMetadata(IDEMPOTENT_POLICY_KEY, handler(name))).toBeUndefined();
    }
  });

  it('validates the PUT body through a pipe', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ShipmentTransfersSettingController, 'setShipmentTransfersSetting') as
      | Record<string, { pipes?: unknown[] }>
      | undefined;
    const withPipes = Object.values(args ?? {}).filter((a) => (a.pipes ?? []).length > 0);
    expect(withPipes).toHaveLength(1);
  });
});

describe('SetShipmentTransfersSettingSchema (contract SetShipmentTransfersSettingCommand)', () => {
  it('accepts exactly {enabled: boolean}', () => {
    expect(SetShipmentTransfersSettingSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(SetShipmentTransfersSettingSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('refuses a missing or non-boolean value and any extra key (tenant and actor never come from the body)', () => {
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: true, tenantId: TENANT }, { enabled: true, override: true }]) {
      expect(SetShipmentTransfersSettingSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('ShipmentTransfersSettingController handlers', () => {
  it('refuses a request without a resolved tenant and user (401) and never calls the service', async () => {
    const { controller, calls } = controllerWith(state());
    for (const context of [undefined, { tenantId: TENANT }, { userId: USER }]) {
      await expect(controller.getShipmentTransfersSetting(request(context))).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(controller.setShipmentTransfersSetting(request(context), { enabled: true })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it('reads the switch for the session caller and derives readinessMet from an empty list', async () => {
    const { controller, calls } = controllerWith(state({ enabled: true, changedAt: '2026-11-22T10:00:00.000Z', changedBy: USER }));
    await expect(controller.getShipmentTransfersSetting(request(session))).resolves.toEqual({
      enabled: true,
      changedAt: '2026-11-22T10:00:00.000Z',
      changedBy: USER,
      delayedTransferThresholdDays: 3,
      readinessMet: true,
      unmetReadiness: [],
    });
    expect(calls).toEqual([{ method: 'getState', args: [{ tenantId: TENANT, userId: USER, isPlatformAdmin: false }] }]);
  });

  it('reports readinessMet false while any boundary is unmet', async () => {
    const unmet = [{ code: 'transit_warehouse_unmapped' as const, message: 'The tenant has no active transit warehouse mapping.' }];
    const { controller } = controllerWith(state({ unmetReadiness: unmet }));
    const body = await controller.getShipmentTransfersSetting(request(session));
    expect(body.readinessMet).toBe(false);
    expect(body.unmetReadiness).toEqual(unmet);
  });

  it('passes the requested value and the platform-admin flag to the service', async () => {
    const { controller, calls } = controllerWith(state({ enabled: true }));
    await controller.setShipmentTransfersSetting(request({ ...session, isPlatformAdmin: true }), { enabled: true });
    expect(calls).toEqual([{ method: 'setEnabled', args: [{ tenantId: TENANT, userId: USER, isPlatformAdmin: true }, true] }]);
  });
});
