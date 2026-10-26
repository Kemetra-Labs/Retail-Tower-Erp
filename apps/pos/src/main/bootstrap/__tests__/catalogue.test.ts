import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    productRepo: {
      marker: 'product-repo',
      countByTenant: vi.fn((tenantId: string) => `count:${tenantId}`),
      countBarcodesByTenant: vi.fn((tenantId: string) => `barcodes:${tenantId}`),
    },
    syncStateRepo: {
      marker: 'sync-state-repo',
      read: vi.fn((tenantId: string) => `sync:${tenantId}`),
    },
    bridge: { marker: 'bridge' },
    client: { marker: 'client' },
    writer: { marker: 'writer' },
    driver: { marker: 'driver', start: vi.fn(), stop: vi.fn() },
    observedFetch: { marker: 'observed-fetch' },
    createProductRepo: vi.fn(),
    createCatalogueSyncStateRepo: vi.fn(),
    createCatalogueBridge: vi.fn(),
    registerCatalogueHandlers: vi.fn(),
    createReadDownClient: vi.fn(),
    createReadDownWriter: vi.fn(),
    createReadDownDriver: vi.fn(),
    withDeviceAuthObservation: vi.fn(),
    resolveApiBaseUrl: vi.fn(),
  };
});

vi.mock('../../catalogue/product-repo.js', () => ({ createProductRepo: m.createProductRepo }));
vi.mock('../../catalogue/catalogue-sync-state-repo.js', () => ({
  createCatalogueSyncStateRepo: m.createCatalogueSyncStateRepo,
}));
vi.mock('../../catalogue/catalogue-bridge.js', () => ({
  createCatalogueBridge: m.createCatalogueBridge,
}));
vi.mock('../../ipc/catalogue.js', () => ({
  registerCatalogueHandlers: m.registerCatalogueHandlers,
}));
vi.mock('../../catalogue/read-down/read-down-client.js', () => ({
  createReadDownClient: m.createReadDownClient,
}));
vi.mock('../../catalogue/read-down/read-down-writer.js', () => ({
  createReadDownWriter: m.createReadDownWriter,
}));
vi.mock('../../catalogue/read-down/read-down-driver.js', () => ({
  createReadDownDriver: m.createReadDownDriver,
}));
vi.mock('../../pairing/device-auth-detector.js', () => ({
  withDeviceAuthObservation: m.withDeviceAuthObservation,
}));
vi.mock('../env.js', () => ({ resolveApiBaseUrl: m.resolveApiBaseUrl }));

import { registerCatalogue } from '../catalogue.js';
import type { CatalogueDeps } from '../catalogue.js';

/**
 * RT-893 extraction 3 — the catalogue IPC and read-down wiring moved verbatim out of
 * `main/index.ts`. `index.ts` cannot be imported under vitest (it runs `app.whenReady()` at module
 * load), so the moved wiring is pinned here directly, with every collaborator replaced by a
 * recording fake. The order of the recorded calls is the boot order the inline code had.
 */
const PAIRED = {
  kind: 'paired',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
} as const;
const UNPAIRED = { kind: 'unpaired' } as const;

type Starter = (terminal: { tenant_id: string; branch_id: string; terminal_id: string }) => void;

interface Harness {
  deps: CatalogueDeps;
  latchStarters: Map<string, Starter>;
  notifyPaired: ReturnType<typeof vi.fn>;
  workerRegister: ReturnType<typeof vi.fn>;
  getCurrent: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  backendFetch: ReturnType<typeof vi.fn>;
  detector: { observe: ReturnType<typeof vi.fn> };
  readToken: ReturnType<typeof vi.fn>;
  db: object;
}

function makeHarness(status: unknown, runStartersOnRegister = false): Harness {
  const latchStarters = new Map<string, Starter>();
  const notifyPaired = vi.fn(() => {
    m.calls.push('notifyPaired');
  });
  const workerRegister = vi.fn();
  const getCurrent = vi.fn((): unknown => null);
  const info = vi.fn();
  const backendFetch = vi.fn();
  const detector = { observe: vi.fn() };
  const readToken = vi.fn((): Promise<string | null> => Promise.resolve('device-token'));
  const db = { marker: 'db' };
  const deps = {
    guardedIpcMain: { handle: vi.fn() },
    db,
    pairingStore: {
      getStatus: vi.fn(() => {
        m.calls.push('getStatus');
        return Promise.resolve(status);
      }),
    },
    pairedWorkersLatch: {
      register: vi.fn((name: string, start: Starter) => {
        m.calls.push(`latch.register:${name}`);
        latchStarters.set(name, start);
        if (runStartersOnRegister && status && (status as { kind: string }).kind === 'paired') {
          start(PAIRED);
        }
      }),
      notifyPaired,
    },
    operatorSessionManager: { getCurrent },
    workerRegistry: { register: workerRegister },
    mainLogger: { info },
    backendFetch,
    deviceAuthDetector: detector,
    readSendableDeviceToken: readToken,
  } as unknown as CatalogueDeps;
  return {
    deps,
    latchStarters,
    notifyPaired,
    workerRegister,
    getCurrent,
    info,
    backendFetch,
    detector,
    readToken,
    db,
  };
}

function bridgeDeps(): {
  getCurrentSession: () => unknown;
  productRepo: unknown;
  freshness: {
    readSyncState: (t: string) => unknown;
    countProducts: (t: string) => unknown;
    countBarcodes: (t: string) => unknown;
  };
  getReadDownDriver: () => unknown;
} {
  return callArg(m.createCatalogueBridge, 0) as ReturnType<typeof bridgeDeps>;
}

function callArg(fn: { mock: { calls: unknown[][] } }, index: number): unknown {
  const call = fn.mock.calls[0];
  if (call === undefined) throw new Error('expected the mock to have been called');
  return call[index];
}

function starterOf(h: Harness): Starter {
  const starter = h.latchStarters.get('read-down driver');
  if (starter === undefined) throw new Error('read-down starter was not registered');
  return starter;
}

beforeEach(() => {
  m.calls.length = 0;
  for (const fn of [
    m.createProductRepo,
    m.createCatalogueSyncStateRepo,
    m.createCatalogueBridge,
    m.registerCatalogueHandlers,
    m.createReadDownClient,
    m.createReadDownWriter,
    m.createReadDownDriver,
    m.withDeviceAuthObservation,
    m.resolveApiBaseUrl,
    m.productRepo.countByTenant,
    m.productRepo.countBarcodesByTenant,
    m.syncStateRepo.read,
    m.driver.start,
    m.driver.stop,
  ]) {
    fn.mockClear();
  }
  m.createProductRepo.mockImplementation(() => {
    m.calls.push('createProductRepo');
    return m.productRepo;
  });
  m.createCatalogueSyncStateRepo.mockImplementation(() => {
    m.calls.push('createCatalogueSyncStateRepo');
    return m.syncStateRepo;
  });
  m.resolveApiBaseUrl.mockImplementation(() => {
    m.calls.push('resolveApiBaseUrl');
    return 'https://api.example.test';
  });
  m.createCatalogueBridge.mockImplementation(() => {
    m.calls.push('createCatalogueBridge');
    return m.bridge;
  });
  m.registerCatalogueHandlers.mockImplementation(() => {
    m.calls.push('registerCatalogueHandlers');
  });
  m.createReadDownClient.mockReturnValue(m.client);
  m.createReadDownWriter.mockReturnValue(m.writer);
  m.createReadDownDriver.mockReturnValue(m.driver);
  m.withDeviceAuthObservation.mockReturnValue(m.observedFetch);
  m.driver.start.mockImplementation(() => {
    m.calls.push('driver.start');
  });
});

describe('registerCatalogue (RT-893 extraction 3)', () => {
  it('keeps the inline boot order on a paired boot', async () => {
    const h = makeHarness(PAIRED, true);
    await registerCatalogue(h.deps);
    // Repos and base URL first, then the pairing read and latch notification, then the bridge and
    // its IPC handlers, and only then the paired-only starter (which runs at once when paired).
    expect(m.calls).toEqual([
      'createProductRepo',
      'createCatalogueSyncStateRepo',
      'resolveApiBaseUrl',
      'getStatus',
      'notifyPaired',
      'createCatalogueBridge',
      'registerCatalogueHandlers',
      'latch.register:read-down driver',
      'driver.start',
    ]);
  });

  it('notifies the latch with the boot pairing scope and returns it', async () => {
    const h = makeHarness(PAIRED);
    const wiring = await registerCatalogue(h.deps);
    expect(h.notifyPaired).toHaveBeenCalledTimes(1);
    expect(h.notifyPaired).toHaveBeenCalledWith({
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
    });
    expect(wiring).toEqual({ bootPairing: PAIRED });
    expect(h.info).not.toHaveBeenCalledWith('read_down_driver:skipped_unpaired');
  });

  it('does not notify the latch on an unpaired boot, logs the skip and returns the status', async () => {
    const h = makeHarness(UNPAIRED);
    const wiring = await registerCatalogue(h.deps);
    expect(h.notifyPaired).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith('read_down_driver:skipped_unpaired');
    expect(wiring.bootPairing).toBe(UNPAIRED);
    // The starter is still registered; it runs when the in-process pairing completes.
    expect(h.latchStarters.has('read-down driver')).toBe(true);
    expect(m.createReadDownDriver).not.toHaveBeenCalled();
  });

  it('registers the catalogue handlers on the guarded ipcMain with the bridge', async () => {
    const h = makeHarness(UNPAIRED);
    await registerCatalogue(h.deps);
    expect(m.registerCatalogueHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      bridge: m.bridge,
    });
    expect(m.createProductRepo).toHaveBeenCalledWith(h.db);
    expect(m.createCatalogueSyncStateRepo).toHaveBeenCalledWith(h.db);
  });

  it('adapts the operator session to the catalogue projection (id becomes operator_session_id)', async () => {
    const h = makeHarness(UNPAIRED);
    await registerCatalogue(h.deps);
    const { getCurrentSession } = bridgeDeps();
    expect(getCurrentSession()).toBeNull();
    h.getCurrent.mockReturnValue({
      id: 'sess-1',
      role: 'manager',
      operator_id: 'op-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      display_name: 'not projected',
    });
    expect(getCurrentSession()).toEqual({
      role: 'manager',
      operator_id: 'op-1',
      operator_session_id: 'sess-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
    });
  });

  it('gives the bridge the product repo and tenant-scoped freshness reads', async () => {
    const h = makeHarness(UNPAIRED);
    await registerCatalogue(h.deps);
    const bridge = bridgeDeps();
    expect(bridge.productRepo).toBe(m.productRepo);
    expect(bridge.freshness.readSyncState('t1')).toBe('sync:t1');
    expect(bridge.freshness.countProducts('t1')).toBe('count:t1');
    expect(bridge.freshness.countBarcodes('t1')).toBe('barcodes:t1');
  });

  it('resolves the read-down driver lazily: undefined until the paired starter has run', async () => {
    const h = makeHarness(UNPAIRED);
    await registerCatalogue(h.deps);
    const { getReadDownDriver } = bridgeDeps();
    expect(getReadDownDriver()).toBeUndefined();
    starterOf(h)(PAIRED);
    expect(getReadDownDriver()).toBe(m.driver);
  });

  describe('the paired-only read-down starter', () => {
    async function runStarter(h: Harness): Promise<void> {
      await registerCatalogue(h.deps);
      starterOf(h)(PAIRED);
    }

    it('builds the client on the device-401-observed fetch tagged read_down, with the sendable token reader', async () => {
      const h = makeHarness(UNPAIRED);
      await runStarter(h);
      expect(m.withDeviceAuthObservation).toHaveBeenCalledWith(h.backendFetch, h.detector, {
        source: 'read_down',
        baseUrl: 'https://api.example.test',
      });
      expect(m.createReadDownClient).toHaveBeenCalledWith({
        baseUrl: 'https://api.example.test',
        fetch: m.observedFetch,
        getDeviceToken: h.readToken,
      });
    });

    it('resolves the API base URL once, before the starter runs', async () => {
      const h = makeHarness(UNPAIRED);
      await runStarter(h);
      expect(m.resolveApiBaseUrl).toHaveBeenCalledTimes(1);
    });

    it('builds the driver with the device-principal scope, an hourly cadence and an ISO clock', async () => {
      const h = makeHarness(UNPAIRED);
      await runStarter(h);
      expect(m.createReadDownWriter).toHaveBeenCalledWith({
        db: h.db,
        syncStateRepo: m.syncStateRepo,
      });
      const driverDeps = callArg(m.createReadDownDriver, 0) as {
        client: unknown;
        writer: unknown;
        tenantId: string;
        branchId: string;
        now: () => string;
        tickIntervalMs: number;
      };
      expect(driverDeps.client).toBe(m.client);
      expect(driverDeps.writer).toBe(m.writer);
      expect(driverDeps.tenantId).toBe('tenant-1');
      expect(driverDeps.branchId).toBe('branch-1');
      expect(driverDeps.tickIntervalMs).toBe(3_600_000);
      expect(driverDeps.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('starts the driver, registers its stop with the worker registry and logs the start', async () => {
      const h = makeHarness(UNPAIRED);
      await runStarter(h);
      expect(m.driver.start).toHaveBeenCalledTimes(1);
      expect(h.workerRegister).toHaveBeenCalledTimes(1);
      expect(callArg(h.workerRegister, 0)).toBe('read-down driver');
      expect(m.driver.stop).not.toHaveBeenCalled();
      (callArg(h.workerRegister, 1) as () => void)();
      expect(m.driver.stop).toHaveBeenCalledTimes(1);
      expect(h.info).toHaveBeenCalledWith({ tenant_id: 'tenant-1' }, 'read_down_driver:started');
    });
  });
});
