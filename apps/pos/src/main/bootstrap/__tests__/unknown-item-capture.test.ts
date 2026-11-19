/**
 * RT-1490 — `registerUnknownItemCapture` end to end on the real migrated
 * schema, with a fake Backend-Core and fake timers:
 *
 *   • the hook defers the enqueue past the lookup (nothing is written inline);
 *   • a paired-only drain is registered, with its stop on the worker registry;
 *   • the queued scan goes on the next interval with the operator ENVELOPE as
 *     bearer (not the device token) and its own key;
 *   • with no operator signed in nothing is sent and the row stays queued,
 *     then goes once an operator signs in;
 *   • the queue survives a restart (a second wiring over the same DB sends the
 *     row queued by the first);
 *   • offline: the row stays pending and goes after reconnect with the same key.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import type { PairedWorkerStarter } from '../../app/paired-workers.js';
import {
  registerUnknownItemCapture,
  UNKNOWN_ITEM_CAPTURE_INTERVAL_MS,
  type UnknownItemCaptureDeps,
} from '../unknown-item-capture.js';

const PAIRED = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };
const SESSION = { tenant_id: 'tenant-1', branch_id: 'branch-1' };

let db: SqlJsDatabase;

beforeAll(async () => {
  await initCatalogueSql();
});

beforeEach(() => {
  db = freshCatalogueDb();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function rows(): unknown[][] {
  return db.exec('SELECT capture_id, state FROM unknown_item_captures')[0]?.values ?? [];
}

function harness(o: { status?: number; envelope?: string | null } = {}) {
  const starters = new Map<string, PairedWorkerStarter>();
  const stops = new Map<string, () => void>();
  let envelope = o.envelope === undefined ? 'env-1' : o.envelope;
  let online = true;
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    online
      ? Promise.resolve(new Response('{}', { status: o.status ?? 201 }))
      : Promise.reject(new Error('offline')),
  );
  const deps: UnknownItemCaptureDeps = {
    db: handleFor(db),
    backendFetch: fetch as never,
    pairingStore: { getCurrentTerminalId: () => 'terminal-1' },
    pairedWorkersLatch: {
      register: (name, start) => {
        starters.set(name, start);
      },
    },
    operatorSessionManager: {
      getCurrent: () => (envelope === null ? null : ({ backend_session_id: 'bs-1' } as never)),
    },
    operatorEnvelopeHolder: { get: (id) => (id === 'bs-1' ? envelope : null) },
    workerRegistry: {
      register: (name, stop) => {
        stops.set(name, stop);
      },
    },
    mainLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    baseUrl: 'https://api.test',
    defer: (fn) => {
      fn();
    },
  };
  return {
    deps,
    fetch,
    starters,
    stops,
    signIn: (value: string) => {
      envelope = value;
    },
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

function start(h: ReturnType<typeof harness>) {
  const hook = registerUnknownItemCapture(h.deps);
  const starter = h.starters.get('unknown-item capture');
  if (starter === undefined) throw new Error('drain starter not registered');
  starter(PAIRED);
  return hook;
}

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(UNKNOWN_ITEM_CAPTURE_INTERVAL_MS);
}

describe('RT-1490 — registerUnknownItemCapture', () => {
  it('defers the enqueue past the lookup reply', () => {
    const h = harness();
    const deferred: (() => void)[] = [];
    const hook = registerUnknownItemCapture({ ...h.deps, defer: (fn) => deferred.push(fn) });
    hook('6221000000099', SESSION);
    expect(rows()).toEqual([]);
    deferred.forEach((fn) => {
      fn();
    });
    expect(rows()).toHaveLength(1);
  });

  it('registers a paired-only drain and its worker stop', () => {
    const h = harness();
    registerUnknownItemCapture(h.deps);
    expect([...h.starters.keys()]).toEqual(['unknown-item capture']);
    expect(h.stops.size).toBe(0);
    h.starters.get('unknown-item capture')?.(PAIRED);
    expect([...h.stops.keys()]).toEqual(['unknown-item capture interval']);
  });

  it('sends a queued scan on the next interval with the operator envelope', async () => {
    const h = harness();
    const hook = start(h);
    hook('6221000000099', SESSION);
    expect(h.fetch).not.toHaveBeenCalled();

    await tick();

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/api/pos/v1/catalog/unknown-items');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer env-1');
    expect(headers['Idempotency-Key']).toBe(rows()[0]?.[0]);
    expect(rows()[0]?.[1]).toBe('sent');
  });

  it('keeps the row queued with no operator signed in, and sends it after sign-in', async () => {
    const h = harness({ envelope: null });
    const hook = start(h);
    hook('6221000000099', SESSION);
    await tick();
    await tick();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(rows()[0]?.[1]).toBe('pending');

    h.signIn('env-2');
    await tick();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(rows()[0]?.[1]).toBe('sent');
  });

  it('survives a restart: a new wiring sends what the old one queued', async () => {
    const before = harness();
    registerUnknownItemCapture(before.deps)('6221000000099', SESSION);
    const key = rows()[0]?.[0];

    const after = harness();
    start(after);
    await tick();
    const init = after.fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(key);
    expect(rows()[0]?.[1]).toBe('sent');
  });

  it('offline: the row stays pending and goes after reconnect with the same key', async () => {
    const h = harness();
    const hook = start(h);
    hook('6221000000099', SESSION);
    h.setOnline(false);
    await tick();
    expect(rows()[0]?.[1]).toBe('pending');

    h.setOnline(true);
    // The loop backed off once (5 s) after the undelivered flush.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rows()[0]?.[1]).toBe('sent');
    const keys = h.fetch.mock.calls.map(
      (c) => (c[1].headers as Record<string, string>)['Idempotency-Key'],
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('stops: no send after the worker stop', async () => {
    const h = harness();
    const hook = start(h);
    hook('6221000000099', SESSION);
    h.stops.get('unknown-item capture interval')?.();
    await tick();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
