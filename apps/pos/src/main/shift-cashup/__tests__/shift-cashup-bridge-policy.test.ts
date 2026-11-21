/**
 * RT-388 — the bridge refreshes the shift variance policy before an open
 * (AD-CASH-001 D-5: "before an online open"), without ever delaying or failing
 * the open on it.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createShiftCashupBridge } from '../shift-cashup-bridge.js';
import {
  OPENED_AT,
  serviceHarness,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';

let db: SqlJsDatabase;
let harness: ServiceHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db);
});

afterEach(() => {
  db.close();
});

function bridgeWith(beforeOpen?: () => Promise<void>) {
  return createShiftCashupBridge({
    service: harness.service,
    enrollment: { enroll: () => Promise.resolve(), revoke: () => Promise.resolve() },
    logger: { info: vi.fn(), warn: vi.fn() },
    ...(beforeOpen === undefined ? {} : { beforeOpen }),
  });
}

describe('open: the policy refresh', () => {
  it('runs the refresh to completion before the open freezes the policy', async () => {
    const order: string[] = [];
    harness.state.policy = { source: 'system', revisionId: null, mode: 'none' };
    const bridge = bridgeWith(async () => {
      await Promise.resolve();
      order.push('refreshed');
      // The refresh brings in a newer policy: the open below must freeze THAT one.
      harness.state.policy = {
        source: 'tenant',
        revisionId: '0190f5a2-3b4c-7d8e-9f01-23456789abc1',
        mode: 'none',
      };
    });
    const opened = await bridge.open({ openingFloatMinor: 50_000 });
    order.push('opened');
    expect(opened).toMatchObject({ kind: 'opened', openedAt: OPENED_AT });
    expect(order).toEqual(['refreshed', 'opened']);
    const row = db.exec('SELECT policy_source FROM shift_cashup_open_policies')[0]?.values;
    expect(row).toEqual([['tenant']]);
  });

  it('opens anyway when the refresh rejects', async () => {
    const bridge = bridgeWith(() => Promise.reject(new Error('network down')));
    expect(await bridge.open({ openingFloatMinor: 50_000 })).toMatchObject({ kind: 'opened' });
  });

  it('opens with no refresh given (the dependency is optional)', async () => {
    expect(await bridgeWith().open({ openingFloatMinor: 50_000 })).toMatchObject({
      kind: 'opened',
    });
  });

  it('does not refresh for any other call', async () => {
    const beforeOpen = vi.fn(() => Promise.resolve());
    const bridge = bridgeWith(beforeOpen);
    await bridge.status();
    expect(beforeOpen).not.toHaveBeenCalled();
  });
});
