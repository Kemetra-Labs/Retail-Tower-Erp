import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { DatabaseHandle } from '../../db/client.js';
import { registerCashierAdmissionKeeper } from '../cashier-admission-keeper.js';
import { CashierAdmissionKeeper } from '../../operator/cashier-admission-keeper.js';
import { SessionManager } from '../../operator/session-manager.js';
import {
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
  const keeper = registerCashierAdmissionKeeper({
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
  return { sessions, fake, events, stops, probe, keeper, stop: () => stopper?.() };
}

describe('registerCashierAdmissionKeeper', () => {
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
