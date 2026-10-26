import { describe, expect, it, vi } from 'vitest';

import { RosterHandler } from '../../../../src/main/operator/roster-handler.js';
import type {
  CashierAdmissionClient,
  CashierRosterResult,
} from '../../../../src/main/operator/cashier-admission-client.js';

/**
 * 004-operator-session T070a / RT-113 P2 — operator.listBranchRoster main-side handler.
 *
 * RT-113 P2 (10763 D11, 10844): the cashier picker reads the
 * device-authenticated `GET /api/pos/v1/cashier-admissions/roster` instead of
 * the Clerk-gated `/operators/roster` (RT-182: 401 without a manager JWT).
 *
 * Verifies:
 *  - Mapping: `{user_id, operator_id, display_name}` → bridge
 *    `{id: operator_id, display_name, role: 'cashier'}` (the session
 *    `operator_id` stays the provider subject, RT-116 seam 1); `user_id` stays
 *    main-side (Constitution VII).
 *  - `source: 'online'` on a live roster (10763 §3).
 *  - Allowlist redaction (FR-006 / FR-031).
 *  - Failure-mode collapse: no_connection / 5xx → no_connection; anything
 *    else → invalid_input.
 *  - FR-032: display names never reach the logger.
 */

function fakeClient(result: CashierRosterResult): {
  client: Pick<CashierAdmissionClient, 'listRoster'>;
  listRoster: ReturnType<typeof vi.fn>;
} {
  const listRoster = vi.fn(() => Promise.resolve(result));
  return { client: { listRoster }, listRoster };
}

const ROSTER: CashierRosterResult = {
  kind: 'roster',
  cashiers: [
    {
      user_id: '0192f6a0-1b2c-7d3e-8f40-123456789abc',
      operator_id: 'user_clerk_1',
      display_name: 'Ali Hassan',
    },
    {
      user_id: '0192f6a0-1b2c-7d3e-8f40-123456789abd',
      operator_id: 'user_clerk_2',
      display_name: 'Sara Nabil',
    },
  ],
};

describe('RosterHandler (device roster)', () => {
  it('maps the device roster to bridge entries keyed on operator_id, with source online', async () => {
    const { client, listRoster } = fakeClient(ROSTER);
    const handler = new RosterHandler({ cashierAdmissions: client });
    const res = await handler.listRoster();
    expect(listRoster).toHaveBeenCalledOnce();
    expect(res).toEqual({
      kind: 'roster',
      source: 'online',
      cashiers: [
        { id: 'user_clerk_1', display_name: 'Ali Hassan', role: 'cashier' },
        { id: 'user_clerk_2', display_name: 'Sara Nabil', role: 'cashier' },
      ],
    });
  });

  it('never lets user_id or any extra field cross the bridge', async () => {
    const leaky = {
      kind: 'roster',
      cashiers: [
        {
          user_id: 'u-1',
          operator_id: 'user_clerk_1',
          display_name: 'Test Cashier',
          email: 'test@pharmacy.test',
          pin_hash: 'hash123',
        },
      ],
    } as unknown as CashierRosterResult;
    const handler = new RosterHandler({ cashierAdmissions: fakeClient(leaky).client });
    const res = await handler.listRoster();
    expect(res.kind).toBe('roster');
    if (res.kind === 'roster') {
      expect(res.cashiers[0]).toEqual({
        id: 'user_clerk_1',
        display_name: 'Test Cashier',
        role: 'cashier',
      });
    }
  });

  it('accepts an empty roster', async () => {
    const handler = new RosterHandler({
      cashierAdmissions: fakeClient({ kind: 'roster', cashiers: [] }).client,
    });
    await expect(handler.listRoster()).resolves.toEqual({
      kind: 'roster',
      source: 'online',
      cashiers: [],
    });
  });

  it.each([
    [{ kind: 'no_connection' }, 'no_connection'],
    [{ kind: 'unavailable' }, 'no_connection'],
    [{ kind: 'device_unauthorized' }, 'invalid_input'],
    [{ kind: 'no_token' }, 'invalid_input'],
    [{ kind: 'rejected' }, 'invalid_input'],
  ] as const)('%o → refused/%s', async (result, category) => {
    const handler = new RosterHandler({
      cashierAdmissions: fakeClient(result).client,
    });
    await expect(handler.listRoster()).resolves.toEqual({ kind: 'refused', category });
  });

  it('FR-032 redaction: logger never receives cashier display names or ids', async () => {
    const logCalls: unknown[] = [];
    const logger = {
      info: (...args: unknown[]) => logCalls.push(...args),
      warn: (...args: unknown[]) => logCalls.push(...args),
    } as unknown as NonNullable<ConstructorParameters<typeof RosterHandler>[0]['logger']>;
    const handler = new RosterHandler({ cashierAdmissions: fakeClient(ROSTER).client, logger });
    await handler.listRoster();
    const serialized = JSON.stringify(logCalls);
    expect(serialized).toContain('operator.roster.fetched');
    expect(serialized).not.toContain('Ali Hassan');
    expect(serialized).not.toContain('user_clerk_1');
    expect(serialized).not.toContain('0192f6a0');
  });
});

/**
 * RT-308 (RT-113 P3, 10763 D11) — the offline roster: only when Backend-Core
 * is unreachable, only cashiers with a currently valid grant on this terminal
 * (`offlineCashiers`), `source: 'offline'`, the same three fields.
 */
describe('RosterHandler (offline roster)', () => {
  const OFFLINE = [
    { operator_id: 'user_clerk_1', display_name: 'Ali Hassan' },
    { operator_id: 'user_clerk_2', display_name: 'Sara Nabil' },
  ];

  it.each([[{ kind: 'no_connection' }], [{ kind: 'unavailable' }]] as const)(
    '%o → the cashiers with a valid grant, source offline',
    async (result) => {
      const offlineCashiers = vi.fn(() => OFFLINE);
      const handler = new RosterHandler({
        cashierAdmissions: fakeClient(result).client,
        offlineCashiers,
      });
      await expect(handler.listRoster()).resolves.toEqual({
        kind: 'roster',
        source: 'offline',
        cashiers: [
          { id: 'user_clerk_1', display_name: 'Ali Hassan', role: 'cashier' },
          { id: 'user_clerk_2', display_name: 'Sara Nabil', role: 'cashier' },
        ],
      });
      expect(offlineCashiers).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [{ kind: 'device_unauthorized' }, 'invalid_input'],
    [{ kind: 'no_token' }, 'invalid_input'],
    [{ kind: 'rejected' }, 'invalid_input'],
  ] as const)('%o (an answer, not unreachable) never falls back offline', async (result, cat) => {
    const offlineCashiers = vi.fn(() => OFFLINE);
    const handler = new RosterHandler({
      cashierAdmissions: fakeClient(result).client,
      offlineCashiers,
    });
    await expect(handler.listRoster()).resolves.toEqual({ kind: 'refused', category: cat });
    expect(offlineCashiers).not.toHaveBeenCalled();
  });

  it('a live roster never consults the offline source', async () => {
    const offlineCashiers = vi.fn(() => OFFLINE);
    const handler = new RosterHandler({
      cashierAdmissions: fakeClient(ROSTER).client,
      offlineCashiers,
    });
    await expect(handler.listRoster()).resolves.toMatchObject({ source: 'online' });
    expect(offlineCashiers).not.toHaveBeenCalled();
  });

  it('nobody with a valid grant, or a failing source, is no_connection', async () => {
    const empty = new RosterHandler({
      cashierAdmissions: fakeClient({ kind: 'no_connection' }).client,
      offlineCashiers: () => [],
    });
    await expect(empty.listRoster()).resolves.toEqual({
      kind: 'refused',
      category: 'no_connection',
    });
    const failing = new RosterHandler({
      cashierAdmissions: fakeClient({ kind: 'no_connection' }).client,
      offlineCashiers: () => {
        throw new Error('store down');
      },
    });
    await expect(failing.listRoster()).resolves.toEqual({
      kind: 'refused',
      category: 'no_connection',
    });
  });

  it('only the three allowlisted fields cross; names never reach the logger', async () => {
    const logCalls: unknown[] = [];
    const logger = {
      info: (...args: unknown[]) => logCalls.push(...args),
    } as unknown as NonNullable<ConstructorParameters<typeof RosterHandler>[0]['logger']>;
    const leaky = [
      {
        operator_id: 'user_clerk_1',
        display_name: 'Ali Hassan',
        user_id: 'u-1',
        admission_id: 'adm-1',
      },
    ];
    const handler = new RosterHandler({
      cashierAdmissions: fakeClient({ kind: 'no_connection' }).client,
      offlineCashiers: () => leaky,
      logger,
    });
    await expect(handler.listRoster()).resolves.toEqual({
      kind: 'roster',
      source: 'offline',
      cashiers: [{ id: 'user_clerk_1', display_name: 'Ali Hassan', role: 'cashier' }],
    });
    const serialized = JSON.stringify(logCalls);
    expect(serialized).toContain('"source":"offline"');
    expect(serialized).not.toContain('Ali Hassan');
    expect(serialized).not.toContain('user_clerk_1');
  });
});
