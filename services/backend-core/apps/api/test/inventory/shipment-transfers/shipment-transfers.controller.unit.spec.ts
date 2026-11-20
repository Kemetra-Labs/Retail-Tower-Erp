/**
 * Jira RT-1513 — the wiring of the shipment Transfer routes (`ShipmentTransfersController`), without a database. The
 * behaviour over real Postgres is `shipment-transfers.db.spec.ts`.
 *
 * Pins what a DB spec cannot see cheaply: the nine contract paths and methods, the guard order, the role gate, the status of
 * each command (a Nest `@Post` answers 201 unless told otherwise; the contract documents 200 for an act on an existing item and
 * 201 for a creation), and `Idempotency-Key` on every command.
 */
import 'reflect-metadata';

import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UnauthorizedException } from '@nestjs/common';

import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { ROLES_METADATA_KEY } from '../../../src/auth/roles.decorator';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import { IDEMPOTENT_POLICY_KEY } from '../../../src/idempotency/idempotent.decorator';
import { ShipmentTransfersController } from '../../../src/inventory/shipment-transfers/shipment-transfers.controller';

const BASE = 'api/inventory/v1/shipment-transfers';
const GET = 0;
const POST = 1;

/** operationId -> [method, path, status (null = Nest default for the method), idempotent command]. */
const OPS: Record<string, readonly [number, string, number | null, boolean]> = {
  createShipmentTransfer: [POST, BASE, 201, true],
  listShipmentTransfers: [GET, BASE, null, false],
  getShipmentTransfer: [GET, `${BASE}/:transferId`, null, false],
  approveShipmentTransfer: [POST, `${BASE}/:transferId/approve`, 200, true],
  cancelShipmentTransfer: [POST, `${BASE}/:transferId/cancel`, 200, true],
  dispatchShipmentTransfer: [POST, `${BASE}/:transferId/dispatch`, 200, true],
  recordShipmentTransferReceipt: [POST, `${BASE}/:transferId/receipts`, 201, true],
  listShipmentTransferReceipts: [GET, `${BASE}/:transferId/receipts`, null, false],
  closeShipmentTransfer: [POST, `${BASE}/:transferId/close`, 200, true],
};

const handler = (name: string): object =>
  Object.getOwnPropertyDescriptor(ShipmentTransfersController.prototype, name)?.value as object;

describe('ShipmentTransfersController wiring', () => {
  it('serves exactly the nine contract operations, by their operationId', () => {
    const own = Object.getOwnPropertyNames(ShipmentTransfersController.prototype).filter((n) => n !== 'constructor' && n !== 'caller');
    expect(own.sort()).toEqual(Object.keys(OPS).sort());
  });

  it.each(Object.entries(OPS))('%s answers on its contract method and path with its documented status', (name, [method, path, status]) => {
    expect(Reflect.getMetadata(METHOD_METADATA, handler(name))).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler(name))).toBe(path);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(status ?? undefined);
  });

  it.each(Object.entries(OPS))('%s requires Idempotency-Key exactly when it is a command', (name, [, , , command]) => {
    const policy = Reflect.getMetadata(IDEMPOTENT_POLICY_KEY, handler(name));
    if (command) expect(policy).toBe('required');
    else expect(policy).toBeUndefined();
  });

  it('authenticates the human session, then the tenant context, then the role, for every route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ShipmentTransfersController)).toEqual([DashboardAuthGuard, TenantContextGuard, RolesGuard]);
  });

  it.each(Object.keys(OPS))('%s admits owner, tenant_admin and store_manager, and answers a wrong role 403', (name) => {
    expect(Reflect.getMetadata(ROLES_METADATA_KEY, handler(name))).toMatchObject({
      any: ['owner', 'tenant_admin', 'store_manager'],
      denyAs: 403,
    });
  });
});

describe('ShipmentTransfersController caller', () => {
  const run = (context: unknown): Promise<unknown> => {
    const calls: unknown[] = [];
    const service = new Proxy({}, { get: () => async (...a: unknown[]) => (calls.push(a), { ok: true }) });
    const controller = new ShipmentTransfersController(service as never);
    return controller.getShipmentTransfer({ context } as never, '0198b000-0000-7000-8000-000000000001');
  };

  it('refuses a request without a resolved tenant and user (401), never trusting the body or a missing context', async () => {
    await expect(run(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(run({ tenantId: null, userId: 'u' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(run({ tenantId: 't', userId: null })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('passes the session context through to the service', async () => {
    await expect(run({ tenantId: 't', userId: 'u', storeId: null })).resolves.toEqual({ ok: true });
  });
});
