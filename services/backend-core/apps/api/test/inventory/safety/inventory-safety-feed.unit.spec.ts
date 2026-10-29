/**
 * Jira RT-449 PR 2 — the POS inventory safety feed controller and page-token
 * codec, unit level (no DB, no guard). The refusals the database spec cannot
 * reach: a principal with no tenant, a device with no resolved store (a
 * `devices` row always has one), and the mapping of the service's answers to
 * the contract's statuses.
 */
import 'reflect-metadata';

import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';

import type { TenantContextRequest } from '../../../src/context/types';
import {
  SafetyFeedCursorError,
  decodePageToken,
  encodePageToken,
} from '../../../src/inventory/safety/inventory-safety-feed.cursor';
import { InventorySafetyFeedController } from '../../../src/inventory/safety/inventory-safety-feed.controller';
import type { InventorySafetyFeedService } from '../../../src/inventory/safety/inventory-safety-feed.service';

const TENANT = '0a000000-0000-7000-8000-00000000ada1';
const STORE = '0a000000-0000-7000-8000-00000000a5a1';
const OTHER_STORE = '0a000000-0000-7000-8000-00000000a5a2';
const HOLD = '0a000000-0000-7000-8000-0000044f4001';

function requestWith(context: TenantContextRequest['context'], deviceId?: string): TenantContextRequest {
  return { context, posDeviceId: deviceId } as unknown as TenantContextRequest;
}

const device = (storeId: string | null) =>
  requestWith(
    { userId: null, tenantId: TENANT, storeId, isPlatformAdmin: false, source: 'token' },
    '0a000000-0000-7000-8000-0000044fd001',
  );

function controllerOver(service: Partial<InventorySafetyFeedService>): InventorySafetyFeedController {
  return new InventorySafetyFeedController(service as InventorySafetyFeedService);
}

describe('InventorySafetyFeedController refusals', () => {
  const never = {
    getSnapshot: jest.fn(),
    getDeltas: jest.fn(),
  };
  const controller = controllerOver(never);

  afterEach(() => jest.clearAllMocks());

  it('refuses a principal with no tenant with a generic 401', async () => {
    await expect(controller.getSnapshot(requestWith(undefined), undefined, undefined, undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      controller.getDeltas(requestWith({ ...device(STORE).context!, tenantId: null }), 0, undefined, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(never.getSnapshot).not.toHaveBeenCalled();
  });

  it('refuses a device with no resolved store with 401 store_context_required', async () => {
    await expect(controller.getSnapshot(device(null), undefined, undefined, undefined)).rejects.toThrow(
      'store_context_required',
    );
    await expect(controller.getDeltas(device(null), 0, undefined, undefined)).rejects.toThrow('store_context_required');
    expect(never.getDeltas).not.toHaveBeenCalled();
  });

  it('refuses a branch_id that is not the device store with a non-disclosing 404, case-insensitively', async () => {
    await expect(controller.getSnapshot(device(STORE), OTHER_STORE, undefined, undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.getDeltas(device(STORE), 0, OTHER_STORE, undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(never.getSnapshot).not.toHaveBeenCalled();
  });
});

describe('InventorySafetyFeedController answers', () => {
  it('passes the device scope, maps a bad page token to 404 and rethrows anything else', async () => {
    const getSnapshot = jest
      .fn()
      .mockResolvedValueOnce({ revision: 3 })
      .mockRejectedValueOnce(new SafetyFeedCursorError('page token scope mismatch'))
      .mockRejectedValueOnce(new Error('boom'));
    const controller = controllerOver({ getSnapshot });
    expect(await controller.getSnapshot(device(STORE), STORE.toUpperCase(), 'tok', 5)).toEqual({ revision: 3 });
    expect(getSnapshot).toHaveBeenCalledWith(TENANT, STORE, { limit: 5, pageToken: 'tok' });
    await expect(controller.getSnapshot(device(STORE), undefined, 'tok', undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.getSnapshot(device(STORE), undefined, undefined, undefined)).rejects.toThrow('boom');
    expect(getSnapshot).toHaveBeenLastCalledWith(TENANT, STORE, { limit: undefined, pageToken: null });
  });

  it('answers a delta page, and 409 snapshot_required with its own code', async () => {
    const page = { revision: 4 };
    const getDeltas = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'page', page })
      .mockResolvedValueOnce({ kind: 'snapshot_required' });
    const controller = controllerOver({ getDeltas });
    expect(await controller.getDeltas(device(STORE), 2, undefined, 10)).toBe(page);
    expect(getDeltas).toHaveBeenCalledWith(TENANT, 2, { limit: 10 });
    const refusal = await controller.getDeltas(device(STORE), 9, undefined, undefined).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toEqual({
      code: 'snapshot_required',
      message: 'snapshot_required',
    });
  });
});

describe('safety feed page token', () => {
  it('round-trips within its own scope', () => {
    const token = encodePageToken({ tenantId: TENANT, storeId: STORE, revision: 7, afterHoldId: HOLD });
    expect(decodePageToken(token, TENANT, STORE)).toEqual({
      tenantId: TENANT,
      storeId: STORE,
      revision: 7,
      afterHoldId: HOLD,
    });
  });

  it.each<[string, unknown]>([
    ['an array', [TENANT]],
    ['a fractional revision', { t: TENANT, s: STORE, r: 1.5, a: HOLD }],
    ['a string revision', { t: TENANT, s: STORE, r: '7', a: HOLD }],
    ['a missing hold id', { t: TENANT, s: STORE, r: 7 }],
  ])('refuses %s', (_label, payload) => {
    const token = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    expect(() => decodePageToken(token, TENANT, STORE)).toThrow(SafetyFeedCursorError);
  });

  it('refuses a token of another store', () => {
    const token = encodePageToken({ tenantId: TENANT, storeId: STORE, revision: 7, afterHoldId: HOLD });
    expect(() => decodePageToken(token, TENANT, OTHER_STORE)).toThrow('scope mismatch');
  });
});
