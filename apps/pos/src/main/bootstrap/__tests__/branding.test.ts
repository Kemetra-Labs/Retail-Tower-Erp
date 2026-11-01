import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

const m = vi.hoisted(() => ({
  broadcastToWindows: vi.fn(),
}));

vi.mock('../window.js', () => ({ broadcastToWindows: m.broadcastToWindows }));
vi.mock('../env.js', () => ({ resolveApiBaseUrl: () => 'https://bc.test' }));

import { registerBranding, type BrandingDeps } from '../branding.js';
import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import {
  TENANT_A,
  fakePairing,
  logoBody,
  paired,
  scriptedFetch,
} from '../../branding/__tests__/__helpers__/branding-fixture.js';
import { BRANDING_IPC_CHANNELS } from '../../../shared/branding/types.js';
import type { PairedWorkerStarter } from '../../app/paired-workers.js';

/**
 * RT-475 — `registerBranding` wiring: the guarded handler, the paired-only
 * worker on the latch, its stop on the worker registry, and the change push.
 * Real cache (sql.js, every migration) and the real client on a scripted fetch.
 */

beforeAll(async () => {
  await initCatalogueSql();
});

afterEach(() => {
  vi.clearAllMocks();
});

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function wire(answers: Parameters<typeof scriptedFetch>[0]) {
  const handlers = new Map<string, Handler>();
  const starters: [string, PairedWorkerStarter][] = [];
  const stops: [string, () => void][] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const scripted = scriptedFetch(answers);
  const deps: BrandingDeps = {
    guardedIpcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    } as unknown as IpcMain,
    db: handleFor(freshCatalogueDb()),
    pairingStore: fakePairing(paired(TENANT_A, 100)),
    pairedWorkersLatch: { register: (name, start) => starters.push([name, start]) },
    workerRegistry: { register: (name, stop) => stops.push([name, stop]) },
    mainLogger: logger as unknown as Logger,
    backendFetch: scripted.fetch,
    readSendableDeviceToken: () => Promise.resolve('device-token'),
  };
  registerBranding(deps);
  const get = () => Promise.resolve(handlers.get(BRANDING_IPC_CHANNELS.GET)?.({}, {}));
  return { handlers, starters, stops, get, sent: scripted.sent };
}

describe('RT-475 — registerBranding', () => {
  it('registers branding:get, answered from the cache before any worker runs', async () => {
    const w = wire([]);
    expect([...w.handlers.keys()]).toEqual([BRANDING_IPC_CHANNELS.GET]);
    await expect(w.get()).resolves.toEqual({ v: 1, kind: 'none' });
    expect(w.sent).toHaveLength(0);
  });

  it('starts the worker on the paired latch, stops it on the registry, and pushes a change', async () => {
    const w = wire([{ status: 200, body: logoBody() }]);
    expect(w.starters.map(([name]) => name)).toEqual(['branding read-down']);
    await w.get(); // memoize `none` first: the push must invalidate it.

    w.starters[0]?.[1]({ tenant_id: TENANT_A, branch_id: 'b', terminal_id: 't' });
    expect(w.stops.map(([name]) => name)).toEqual(['branding read-down']);

    await vi.waitFor(() => {
      expect(m.broadcastToWindows).toHaveBeenCalledWith(
        BRANDING_IPC_CHANNELS.CHANGED,
        expect.objectContaining({ kind: 'logo' }),
      );
    });
    await expect(w.get()).resolves.toEqual(expect.objectContaining({ kind: 'logo' }));
    expect(w.sent).toEqual([null]);
    w.stops[0]?.[1]();
  });
});

describe('RT-475 — registerBranding failure logging', () => {
  it.each([
    ['an Error', new Error('boom'), 'Error'],
    ['a non-Error', 'boom', 'unknown'],
  ])('logs a snapshot fault (%s) by name only and answers none', async (_label, thrown, name) => {
    const handlers = new Map<string, Handler>();
    const warn = vi.fn();
    registerBranding({
      guardedIpcMain: {
        handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      } as unknown as IpcMain,
      db: handleFor(freshCatalogueDb()),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error branch is under test
      pairingStore: { getStatus: () => Promise.reject(thrown) },
      pairedWorkersLatch: { register: () => undefined },
      workerRegistry: { register: () => undefined },
      mainLogger: { info: vi.fn(), warn, error: vi.fn() } as unknown as Logger,
      backendFetch: scriptedFetch([]).fetch,
      readSendableDeviceToken: () => Promise.resolve(null),
    });
    await expect(handlers.get(BRANDING_IPC_CHANNELS.GET)?.({}, {})).resolves.toEqual({
      v: 1,
      kind: 'none',
    });
    expect(warn).toHaveBeenCalledWith({ error: name }, 'branding:snapshot_failed');
  });

  it.each([
    ['an Error', new Error('closed'), 'Error'],
    ['a non-Error', 'closed', 'unknown'],
  ])('logs a push fault (%s) by name only', async (_label, thrown, name) => {
    m.broadcastToWindows.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the non-Error branch is under test
      throw thrown;
    });
    const warn = vi.fn();
    const starters: PairedWorkerStarter[] = [];
    registerBranding({
      guardedIpcMain: { handle: () => undefined } as unknown as IpcMain,
      db: handleFor(freshCatalogueDb()),
      pairingStore: fakePairing(paired(TENANT_A, 100)),
      pairedWorkersLatch: { register: (_name, start) => starters.push(start) },
      workerRegistry: { register: () => undefined },
      mainLogger: { info: vi.fn(), warn, error: vi.fn() } as unknown as Logger,
      backendFetch: scriptedFetch([{ status: 200, body: logoBody() }]).fetch,
      readSendableDeviceToken: () => Promise.resolve('device-token'),
    });
    starters[0]?.({ tenant_id: TENANT_A, branch_id: 'b', terminal_id: 't' });
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith({ error: name }, 'branding:push_failed');
    });
    m.broadcastToWindows.mockReset();
  });
});
