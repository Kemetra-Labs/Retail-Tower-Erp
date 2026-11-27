import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { DatabaseHandle } from '../../db/client.js';
import { SESSION_LOCK_IPC_CHANNELS } from '../../../shared/operator/channels.js';
import { registerCashierAdmissionKeeper } from '../cashier-admission-keeper.js';
import { CashierAdmissionKeeper } from '../../operator/cashier-admission-keeper.js';
import { SessionManager } from '../../operator/session-manager.js';
import {
  ADMITTED,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../operator/__tests__/__helpers__/fake-cashier-admission.js';

/**
 * RT-309 (RT-893) — `registerCashierAdmissionKeeper` composes the keeper outside
 * `index.ts`: the safe-point probe, the durable reconcile audit on the shared
 * emitter, the late-bound sale-boundary re-check and the stop on the worker
 * registry (with the device-401 detector). It returns the one keeper instance.
 */

const silent = { info: () => undefined, warn: () => undefined } as unknown as Logger;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function wire() {
  const sessions = new SessionManager();
  const fake = fakeCashierAdmission();
  const events: AuditEvent[] = [];
  const stops: string[] = [];
  const probe = { recheck: (): void => undefined };
  let stopper: (() => void) | undefined;
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  const keeper = registerCashierAdmissionKeeper({
    ipcMain,
    verifyCashierPin: (_operator_id, pin) =>
      Promise.resolve(pin === '1234' ? null : { kind: 'refused', category: 'invalid_input' }),
    db: {} as DatabaseHandle,
    sessionManager: sessions,
    pairingStore: { getCurrentTerminalId: () => 'term-1' },
    admission: fake.deps,
    auditEmitter: { emit: (e) => events.push(e) },
    saleBoundaryProbe: probe,
    workerRegistry: {
      register: (name, stop) => {
        stops.push(name);
        stopper = stop;
      },
    },
    deviceAuthDetector: { stop: () => stops.push('detector stopped') },
    mainLogger: silent,
  });
  return { sessions, fake, events, stops, probe, keeper, handlers, stop: () => stopper?.() };
}

describe('registerCashierAdmissionKeeper', () => {
  it('RT-309 D9: a reconcile conflict locks the session and resolveConflict ends it here, audited', async () => {
    const w = wire();
    w.fake.setReconcile({ kind: 'active_elsewhere' });
    const ends: Array<string | undefined> = [];
    w.sessions.onEnded((_r, cause) => ends.push(cause));
    w.sessions.create({
      operator_id: 'user_clerk_1',
      display_name: 'Mona',
      role: 'cashier',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: '',
      offline_admission: {
        user_id: FAKE_USER_ID,
        valid_until_ms: Date.now() + 3_600_000,
        deadline_mono_ms: performance.now() + 3_600_000,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');

    const resolve = w.handlers.get(SESSION_LOCK_IPC_CHANNELS.RESOLVE_CONFLICT);
    expect(resolve).toBeDefined();
    await expect(resolve?.({}, { action: 'end_here', pin: '0000' })).resolves.toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
    await expect(resolve?.({}, { action: 'end_here', pin: '1234', extra: 'x' })).resolves.toEqual({
      kind: 'resolved',
      action: 'end_here',
    });
    expect(ends).toEqual(['superseded_by_takeover']);
    expect(w.events.map((e) => [e.action_category, e.payload])).toEqual([
      ['operator.session.authority_conflict', { resolution: 'end_here' }],
    ]);
  });

  it('RT-309 D9: resolveConflict take_over_here adopts the same session and the keeper arms its heartbeat', async () => {
    const w = wire();
    w.fake.setReconcile({ kind: 'active_elsewhere' });
    // The till clock check (RT-1312 F18) runs in production wiring: answer with the till's time.
    w.fake.setAdmit(() => ({ ...ADMITTED, server_time: new Date().toISOString() }));
    const record = w.sessions.create({
      operator_id: 'user_clerk_1',
      display_name: 'Mona',
      role: 'cashier',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: '',
      offline_admission: {
        user_id: FAKE_USER_ID,
        valid_until_ms: Date.now() + 3_600_000,
        deadline_mono_ms: performance.now() + 3_600_000,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const resolve = w.handlers.get(SESSION_LOCK_IPC_CHANNELS.RESOLVE_CONFLICT);

    await expect(resolve?.({}, { action: 'take_over_here', pin: '1234' })).resolves.toEqual({
      kind: 'resolved',
      action: 'take_over_here',
    });
    expect(w.sessions.getCurrent()?.id).toBe(record.id);
    expect(w.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(w.fake.admitCalls).toHaveLength(1);
    expect(w.fake.admitCalls[0]).toMatchObject({ takeover: true });

    // The keeper armed the adopted admission: its heartbeat (takeover: false) follows.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(w.fake.admitCalls.length).toBeGreaterThan(1);
    expect(w.fake.admitCalls[1]).toMatchObject({ takeover: false });
  });

  it.each([
    null,
    'x',
    {},
    { action: 'unlock', pin: '1234' },
    { action: 'end_here', pin: '' },
    { action: 'end_here', pin: 1234 },
  ])(
    'RT-309 D9: resolveConflict refuses a malformed request %o before anything runs',
    async (bad) => {
      const w = wire();
      const resolve = w.handlers.get(SESSION_LOCK_IPC_CHANNELS.RESOLVE_CONFLICT);
      await expect(resolve?.({}, bad)).resolves.toEqual({
        kind: 'refused',
        category: 'invalid_input',
      });
    },
  );

  it('returns the keeper, binds the sale-boundary re-check to it and registers its stop', () => {
    const w = wire();
    expect(w.keeper).toBeInstanceOf(CashierAdmissionKeeper);
    const spy = vi.spyOn(w.keeper, 'recheckSafePoint');
    w.probe.recheck();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(w.stops).toEqual(['cashier admission heartbeat']);
    w.stop();
    expect(w.stops).toEqual(['cashier admission heartbeat', 'detector stopped']);
  });

  it('audits an offline reconcile conversion on the shared emitter before the upgrade', async () => {
    const w = wire();
    const record = w.sessions.create({
      operator_id: 'user_clerk_1',
      display_name: 'Mona',
      role: 'cashier',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: '',
      offline_admission: {
        user_id: FAKE_USER_ID,
        valid_until_ms: Date.now() + 3_600_000,
        deadline_mono_ms: performance.now() + 3_600_000,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(
      w.events.map((e) => [e.action_category, e.session_id, e.originating_terminal_id]),
    ).toEqual([['operator.session.offline_reconciled', record.id, 'term-1']]);
    w.keeper.stop();
  });
});
