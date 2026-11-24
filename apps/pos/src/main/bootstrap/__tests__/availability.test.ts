import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

vi.mock('../env.js', () => ({ resolveApiBaseUrl: () => 'https://bc.test' }));

import { registerAvailability } from '../availability.js';
import type { CatalogueDeps } from '../catalogue.js';
import { AVAILABILITY_IPC_CHANNELS } from '../../../shared/availability/channels.js';
import { handleFor } from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import {
  cloneMigratedDb,
  initMigratedDbTemplate,
} from '../../db/__tests__/__helpers__/migrated-db.js';
import type { PairedWorkerStarter } from '../../app/paired-workers.js';

/**
 * RT-1578 — `registerAvailability` wiring: the guarded handlers, the paired-only worker on the latch, its
 * stop on the worker registry, and the read-only guarantee (GET snapshot calls only).
 */

const STORE = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const P1 = '0192f5a2-3b4c-7d8e-9f01-000000000001';

beforeAll(async () => {
  await initMigratedDbTemplate();
});

afterEach(() => {
  vi.useRealTimers();
});

function wire(
  session: object | null,
  fetchImpl: CatalogueDeps['backendFetch'],
  failStatus?: unknown,
) {
  const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<unknown>>();
  const starters: PairedWorkerStarter[] = [];
  const stops: Array<() => void> = [];
  const warn = vi.fn();
  const db = cloneMigratedDb();
  const deps = {
    guardedIpcMain: {
      handle: (channel: string, fn: (event: unknown, request?: unknown) => Promise<unknown>) => {
        handlers.set(channel, fn);
      },
    } as unknown as IpcMain,
    db: handleFor(db),
    pairingStore: {
      getStatus: () =>
        failStatus !== undefined
          ? // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error cause is the case under test
            Promise.reject(failStatus)
          : Promise.resolve({
              kind: 'paired' as const,
              tenant_id: 't1',
              branch_id: STORE,
              terminal_id: 'term',
              terminal_label: 'l',
              paired_at: 5,
            }),
    },
    pairedWorkersLatch: {
      register: (_name: string, start: PairedWorkerStarter) => starters.push(start),
    },
    operatorSessionManager: { getCurrent: () => session },
    workerRegistry: { register: (_name: string, stop: () => void) => stops.push(stop) },
    mainLogger: { info: vi.fn(), warn } as unknown as Logger,
    backendFetch: fetchImpl,
    readSendableDeviceToken: () => Promise.resolve('device-token'),
  } as unknown as CatalogueDeps;
  registerAvailability(deps);
  return { handlers, starters, stops, warn, db };
}

const page = (): Promise<Response> =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        storeId: STORE,
        asOf: new Date().toISOString(),
        items: [{ productId: P1, availableToSell: '3', band: 'low' }],
        nextCursor: null,
      }),
      { status: 200 },
    ),
  );

describe('registerAvailability', () => {
  it('registers the three channels and answers them for a signed-in operator', async () => {
    const fetchSpy = vi.fn<CatalogueDeps['backendFetch']>(() => page());
    const { handlers, db } = wire({ id: 's' }, fetchSpy);
    expect([...handlers.keys()].sort()).toEqual(Object.values(AVAILABILITY_IPC_CHANNELS).sort());
    await expect(handlers.get(AVAILABILITY_IPC_CHANNELS.REFRESH)?.({})).resolves.toEqual({
      kind: 'done',
      outcome: 'refreshed',
    });
    await expect(
      handlers.get(AVAILABILITY_IPC_CHANNELS.BANDS)?.({}, { product_ids: [P1] }),
    ).resolves.toMatchObject({ kind: 'ok', state: 'fresh', states: { [P1]: 'low' } });
    for (const [, init] of fetchSpy.mock.calls) expect(init?.method).toBe('GET');
    db.close();
  });

  it('refuses every channel with no operator session', async () => {
    const fetchSpy = vi.fn<CatalogueDeps['backendFetch']>(() => page());
    const { handlers, db } = wire(null, fetchSpy);
    await expect(handlers.get(AVAILABILITY_IPC_CHANNELS.STATUS)?.({})).resolves.toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });

  it('the paired-only worker pulls at once, and its registered stop ends the interval', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn<CatalogueDeps['backendFetch']>(() => page());
    const { starters, stops, db } = wire({ id: 's' }, fetchSpy);
    expect(starters).toHaveLength(1);
    starters[0]?.({ tenant_id: 't1', branch_id: STORE, terminal_id: 'term' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    stops[0]?.();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    db.close();
  });

  it.each([
    [new TypeError('x'), 'TypeError'],
    ['plain', 'unknown'],
  ])('a failing pairing read is logged by error name only (%s)', async (cause, logged) => {
    const { handlers, warn, db } = wire({ id: 's' }, page, cause);
    await expect(handlers.get(AVAILABILITY_IPC_CHANNELS.REFRESH)?.({})).resolves.toEqual({
      kind: 'done',
      outcome: 'failed',
    });
    expect(warn).toHaveBeenCalledWith({ error: logged }, 'availability:refresh_failed');
    db.close();
  });
});
