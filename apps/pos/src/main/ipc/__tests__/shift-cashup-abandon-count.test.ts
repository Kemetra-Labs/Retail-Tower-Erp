/**
 * RT-1003 — `shiftCashup:abandonCount` (§A4): the renderer reports that the
 * cashier walked away from a blind count they had entered.
 *
 *   • IPC: the payload is exactly `{ countedCashMinor }`, a safe integer ≥ 0;
 *     anything else (an actor, a shift, an id, a time, an outcome, a missing
 *     or non-integer amount) is `invalid_input` before the bridge runs; the
 *     channel is refused while the session is locked (not on the allowlist).
 *   • Bridge (over the real service and repository): the answer is
 *     `{ kind: 'recorded' }` and nothing else — no id, no amount, no expected
 *     cash, no variance; a refusal is the closed envelope, logged by reason.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SHIFT_CASHUP_IPC_CHANNELS } from '../../../shared/shift-cashup/channels.js';
import type { ShiftCashupBridgeAPI } from '../../../shared/shift-cashup/types.js';
import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  createShiftCashupBridge,
  SHIFT_CASHUP_REFUSED_LOG,
} from '../../shift-cashup/shift-cashup-bridge.js';
import {
  CLOSED_AT,
  serviceHarness,
  type ServiceHarness,
} from '../../shift-cashup/__tests__/__helpers__/shift-cashup-service-fixture.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';
import { readAbandonCountRequest, registerShiftCashupHandlers } from '../shift-cashup.js';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const { ABANDON_COUNT } = SHIFT_CASHUP_IPC_CHANNELS;
const INVALID = { kind: 'refused', reason: 'invalid_input' };
const FLOAT = 50_000;

function setup(locked = false) {
  const handlers = new Map<string, Listener>();
  const raw = {
    handle: vi.fn((channel: string, listener: Listener) => handlers.set(channel, listener)),
    on: () => raw,
  };
  const abandonCount = vi.fn(() => Promise.resolve({ kind: 'recorded' }));
  registerShiftCashupHandlers(
    createSessionLockGuardedIpcMain(raw as unknown as IpcMain, () => locked),
    { bridge: { abandonCount } as unknown as ShiftCashupBridgeAPI },
  );
  const invoke = async (...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(ABANDON_COUNT);
    if (handler === undefined) throw new Error(`no handler for ${ABANDON_COUNT}`);
    return await handler({} as IpcMainInvokeEvent, ...args);
  };
  return { invoke, abandonCount };
}

describe('shiftCashup:abandonCount — the channel', () => {
  it('is named, and not on the locked-session allowlist', () => {
    expect(ABANDON_COUNT).toBe('shiftCashup:abandonCount');
    expect(LOCKED_ALLOWED_CHANNELS.has(ABANDON_COUNT)).toBe(false);
  });

  it('is refused while the session is locked, before the bridge', async () => {
    const { invoke, abandonCount } = setup(true);
    await expect(invoke({ countedCashMinor: 1 })).rejects.toBeInstanceOf(SessionLockedError);
    expect(abandonCount).not.toHaveBeenCalled();
  });

  it.each([0, 1, 54_321, Number.MAX_SAFE_INTEGER])(
    'passes { countedCashMinor: %d } to the bridge unchanged',
    async (countedCashMinor) => {
      const { invoke, abandonCount } = setup();
      await expect(invoke({ countedCashMinor })).resolves.toEqual({ kind: 'recorded' });
      expect(abandonCount).toHaveBeenCalledWith({ countedCashMinor });
    },
  );

  it.each<unknown>([
    undefined,
    null,
    [],
    'x',
    7,
    {},
    { countedCashMinor: -1 },
    { countedCashMinor: 1.5 },
    { countedCashMinor: '100' },
    { countedCashMinor: Number.NaN },
    { countedCashMinor: Number.MAX_SAFE_INTEGER + 1 },
    { countedCashMinor: null },
    { countedCashMinor: 1, actorUserId: '0190f5a2-3b4c-7d8e-9f01-23456789abcd' },
    { countedCashMinor: 1, shiftId: '0192f5a2-3b4c-7d8e-9f01-000000000001' },
    { countedCashMinor: 1, attemptId: '0192f5a2-3b4c-7d8e-9f01-000000000002' },
    { countedCashMinor: 1, attemptedAt: '2026-10-05T16:00:00.000Z' },
    { countedCashMinor: 1, outcome: 'accepted' },
  ])('refuses %j as invalid_input, before the bridge', async (payload) => {
    const { invoke, abandonCount } = setup();
    await expect(invoke(payload)).resolves.toEqual(INVALID);
    expect(abandonCount).not.toHaveBeenCalled();
    expect(readAbandonCountRequest(payload)).toBeNull();
  });
});

describe('shiftCashup.abandonCount — the bridge over the real service', () => {
  let db: SqlJsDatabase;
  let harness: ServiceHarness;
  type LogFn = (payload: Record<string, unknown>, message: string) => void;
  let logger: { info: Mock<LogFn>; warn: Mock<LogFn> };
  let bridge: ShiftCashupBridgeAPI;

  beforeAll(async () => {
    await initSalesSyncSql();
  });

  beforeEach(() => {
    db = freshSalesSyncDb();
    harness = serviceHarness(db);
    logger = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>() };
    bridge = createShiftCashupBridge({
      service: harness.service,
      enrollment: { enroll: vi.fn(), revoke: vi.fn() },
      logger,
    });
  });

  afterEach(() => {
    db.close();
  });

  const outcomes = (): unknown[][] =>
    db.exec('SELECT counted_cash_minor, outcome FROM shift_count_attempts ORDER BY rowid')[0]
      ?.values ?? [];

  it('records the abandoned count and answers recorded, nothing else', async () => {
    await bridge.open({ openingFloatMinor: FLOAT });
    harness.state.clock = CLOSED_AT;

    await expect(bridge.abandonCount({ countedCashMinor: FLOAT - 500 })).resolves.toStrictEqual({
      kind: 'recorded',
    });
    expect(outcomes()).toEqual([[FLOAT - 500, 'abandoned']]);
  });

  it('answers no open shift as the closed refusal, logging the reason only', async () => {
    await expect(bridge.abandonCount({ countedCashMinor: 1 })).resolves.toStrictEqual({
      kind: 'refused',
      reason: 'shift_not_open',
    });
    expect(logger.info).toHaveBeenCalledWith(
      { op: 'abandonCount', reason: 'shift_not_open' },
      SHIFT_CASHUP_REFUSED_LOG,
    );
    expect(outcomes()).toEqual([]);
  });
});
