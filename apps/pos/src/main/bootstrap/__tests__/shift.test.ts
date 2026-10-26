import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

const m = vi.hoisted(() => ({
  startShiftSync: vi.fn(),
  registerShiftCashupIpc: vi.fn(),
  createManagerEnvelopeReader: vi.fn(),
  createCurrentTerminalResolver: vi.fn(),
  managerIdentityOf: vi.fn(),
  resolveSessionScope: vi.fn(),
  resolveApiBaseUrl: vi.fn(),
}));

// The flag gate of the shift sync engine is the real `registerShiftSync`; only its engine factory
// (`startShiftSync`) is replaced, so the test observes whether the paired-only starter is registered.
vi.mock('../../shift-cashup/compose-shift-cashup.js', async (importActual) => {
  const actual = await importActual<typeof import('../../shift-cashup/compose-shift-cashup.js')>();
  return { ...actual, startShiftSync: m.startShiftSync };
});
vi.mock('../../ipc/shift-cashup.js', () => ({ registerShiftCashupIpc: m.registerShiftCashupIpc }));
vi.mock('../../operator/manager-envelope-token.js', () => ({
  createManagerEnvelopeReader: m.createManagerEnvelopeReader,
}));
vi.mock('../../sales-sync/current-terminal.js', () => ({
  createCurrentTerminalResolver: m.createCurrentTerminalResolver,
}));
vi.mock('../../operator/manager-pin-enrollment.js', () => ({
  managerIdentityOf: m.managerIdentityOf,
}));
vi.mock('../../operator/resolve-session-scope.js', () => ({
  resolveSessionScope: m.resolveSessionScope,
}));
vi.mock('../env.js', () => ({ resolveApiBaseUrl: m.resolveApiBaseUrl }));

import { registerShift } from '../shift.js';
import type { ShiftDeps } from '../shift.js';

/**
 * RT-893 extraction 4 — the shift cash-up wiring moved verbatim out of `main/index.ts`.
 * `index.ts` cannot be imported under vitest (it runs `app.whenReady()` at module load), so the
 * moved wiring is pinned here directly, with every collaborator replaced by a recording fake and
 * both states of `POS_PULSE_FEATURE_SHIFT_CASHUP` exercised.
 */
const FLAG = 'POS_PULSE_FEATURE_SHIFT_CASHUP';

interface Harness {
  deps: ShiftDeps;
  pairedWorkersRegister: ReturnType<typeof vi.fn>;
  workersRegister: ReturnType<typeof vi.fn>;
  onStarted: ReturnType<typeof vi.fn>;
  notifyShiftClosed: ReturnType<typeof vi.fn>;
  getCurrent: Mock<() => unknown>;
  getCurrentTerminalId: ReturnType<typeof vi.fn>;
  getStatus: Mock<() => Promise<unknown>>;
  getPairingEpoch: ReturnType<typeof vi.fn>;
  drainRef: ShiftDeps['shiftSyncDrainNowRef'];
}

function makeHarness(): Harness {
  const pairedWorkersRegister = vi.fn();
  const workersRegister = vi.fn();
  const onStarted = vi.fn();
  const notifyShiftClosed = vi.fn();
  const getCurrent = vi.fn<() => unknown>(() => ({ marker: 'session', lock_state: 'unlocked' }));
  const getCurrentTerminalId = vi.fn(() => 'terminal-1');
  const getStatus = vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({
      kind: 'paired',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
    }),
  );
  const getPairingEpoch = vi.fn(() => 'epoch-1');
  const drainRef: ShiftDeps['shiftSyncDrainNowRef'] = { current: null };
  const deps = {
    guardedIpcMain: { marker: 'guarded-ipc-main' },
    db: { marker: 'db' },
    pairingStore: { getStatus, getCurrentTerminalId, getPairingEpoch },
    pairedWorkersLatch: { register: pairedWorkersRegister },
    workerRegistry: { register: workersRegister },
    operatorSessionManager: { getCurrent, onStarted },
    operatorEnvelopeHolder: { marker: 'envelope-holder' },
    mainLogger: { marker: 'logger' },
    backendFetch: vi.fn(),
    deviceAuthDetector: { marker: 'detector' },
    readSendableDeviceToken: vi.fn(),
    safeStorage: { marker: 'safe-storage' },
    managerPins: { marker: 'manager-pins' },
    updateService: { notifyShiftClosed },
    shiftSyncDrainNowRef: drainRef,
  } as unknown as ShiftDeps;
  return {
    deps,
    pairedWorkersRegister,
    workersRegister,
    onStarted,
    notifyShiftClosed,
    getCurrent,
    getCurrentTerminalId,
    getStatus,
    getPairingEpoch,
    drainRef,
  };
}

function ipcDeps(): Record<string, unknown> {
  const call = m.registerShiftCashupIpc.mock.calls.at(-1) as [Record<string, unknown>] | undefined;
  if (call === undefined) throw new Error('registerShiftCashupIpc was not called');
  return call[0];
}

/** The paired-only starter `registerShiftSync` registered with the latch. */
function pairedStarter(h: Harness): (terminal: Record<string, string>) => void {
  const call = h.pairedWorkersRegister.mock.calls.at(0) as
    | [string, (terminal: Record<string, string>) => void]
    | undefined;
  if (call === undefined) throw new Error('no paired-only starter was registered');
  return call[1];
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.resolveApiBaseUrl.mockReturnValue('https://backend.example.test');
  m.createManagerEnvelopeReader.mockReturnValue('manager-envelope-reader');
  m.createCurrentTerminalResolver.mockImplementation((read: () => Promise<unknown>) => read);
  m.managerIdentityOf.mockReturnValue('manager-identity');
  m.resolveSessionScope.mockReturnValue('session-scope');
  m.startShiftSync.mockReturnValue(() => Promise.resolve(true));
  vi.stubEnv(FLAG, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registerShift, flag off (the default)', () => {
  it('registers no starter, no stop and starts no engine', () => {
    const h = makeHarness();
    registerShift(h.deps);
    expect(h.pairedWorkersRegister).not.toHaveBeenCalled();
    expect(h.workersRegister).not.toHaveBeenCalled();
    expect(m.startShiftSync).not.toHaveBeenCalled();
    expect(h.drainRef.current).toBeNull();
  });

  it('hands the IPC registration enabled=false and a live isEnabled that reads false', () => {
    registerShift(makeHarness().deps);
    const deps = ipcDeps();
    expect(deps.enabled).toBe(false);
    expect((deps.isEnabled as () => boolean)()).toBe(false);
  });

  it.each(['', '0', 'false', 'off'])('treats %j as off', (raw) => {
    vi.stubEnv(FLAG, raw);
    const h = makeHarness();
    registerShift(h.deps);
    expect(h.pairedWorkersRegister).not.toHaveBeenCalled();
    expect(ipcDeps().enabled).toBe(false);
  });
});

describe('registerShift, flag on', () => {
  beforeEach(() => {
    vi.stubEnv(FLAG, 'true');
  });

  it('registers the paired-only shift-sync starter, without starting the engine yet', () => {
    const h = makeHarness();
    registerShift(h.deps);
    expect(h.pairedWorkersRegister).toHaveBeenCalledTimes(1);
    expect(h.pairedWorkersRegister.mock.calls[0]?.[0]).toBe('shift-sync engine');
    expect(m.startShiftSync).not.toHaveBeenCalled();
    expect(h.workersRegister).not.toHaveBeenCalled();
  });

  it('starts the engine for the paired terminal on the sale-sync sources and registers its stop', async () => {
    const h = makeHarness();
    registerShift(h.deps);
    const terminal = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };
    pairedStarter(h)(terminal);

    expect(m.startShiftSync).toHaveBeenCalledTimes(1);
    const start = m.startShiftSync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(start.db).toBe(h.deps.db);
    expect(start.terminal).toBe(terminal);
    expect(start.logger).toBe(h.deps.mainLogger);
    const client = start.client as Record<string, unknown>;
    expect(client.baseUrl).toBe('https://backend.example.test');
    expect(client.fetch).toBe(h.deps.backendFetch);
    expect(client.detector).toBe(h.deps.deviceAuthDetector);
    expect(client.getDeviceToken).toBe(h.deps.readSendableDeviceToken);
    expect((client.currentTerminalId as () => string | null)()).toBe('terminal-1');
    // The forced close goes out under the manager / admin envelope only.
    expect(client.getEnvelope).toBe('manager-envelope-reader');
    expect(m.createManagerEnvelopeReader).toHaveBeenCalledWith(
      h.deps.operatorSessionManager,
      h.deps.operatorEnvelopeHolder,
    );
    // The live current-terminal resolver reads the pairing status each call.
    await (start.resolveTerminalId as () => Promise<unknown>)();
    expect(h.getStatus).toHaveBeenCalledTimes(1);

    expect(h.workersRegister).toHaveBeenCalledTimes(1);
    expect(h.workersRegister.mock.calls[0]?.[0]).toBe('shift-sync interval');
  });

  it('stops the engine synchronously from the registered worker stop', () => {
    const h = makeHarness();
    const stop = vi.fn(() => Promise.resolve(true));
    m.startShiftSync.mockReturnValue(stop);
    registerShift(h.deps);
    pairedStarter(h)({ tenant_id: 't', branch_id: 'b', terminal_id: 'x' });
    const stopWorker = h.workersRegister.mock.calls[0]?.[1] as () => void;
    expect(stop).not.toHaveBeenCalled();
    stopWorker();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('publishes the drain-now handle through the ref the forced close reads', () => {
    const h = makeHarness();
    registerShift(h.deps);
    pairedStarter(h)({ tenant_id: 't', branch_id: 'b', terminal_id: 'x' });
    const start = m.startShiftSync.mock.calls[0]?.[0] as {
      onDrainNow: (drainNow: () => Promise<boolean>) => void;
    };
    expect(h.drainRef.current).toBeNull();
    const drainNow = (): Promise<boolean> => Promise.resolve(true);
    start.onDrainNow(drainNow);
    expect(h.drainRef.current).toBe(drainNow);
  });

  it('hands the IPC registration enabled=true and a live isEnabled that follows the flag', () => {
    registerShift(makeHarness().deps);
    const deps = ipcDeps();
    expect(deps.enabled).toBe(true);
    const isEnabled = deps.isEnabled as () => boolean;
    expect(isEnabled()).toBe(true);
    // The service re-reads the flag on every call.
    vi.stubEnv(FLAG, 'false');
    expect(isEnabled()).toBe(false);
  });
});

describe('registerShift IPC wiring (both flag states pass the same sources)', () => {
  it.each([undefined, 'true'])(
    'wires the live session, pairing and manager seams (flag %j)',
    async (raw) => {
      vi.stubEnv(FLAG, raw);
      const h = makeHarness();
      registerShift(h.deps);
      const deps = ipcDeps();

      expect(deps.ipcMain).toBe(h.deps.guardedIpcMain);
      expect(deps.db).toBe(h.deps.db);
      expect(deps.safeStorage).toBe(h.deps.safeStorage);
      expect(deps.logger).toBe(h.deps.mainLogger);
      expect(deps.managerPins).toBe(h.deps.managerPins);

      // getSession resolves the live operator session against the current terminal.
      expect((deps.getSession as () => unknown)()).toBe('session-scope');
      expect(m.resolveSessionScope).toHaveBeenCalledWith(h.getCurrent(), 'terminal-1');
      // isSessionLocked reads the live lock state.
      expect((deps.isSessionLocked as () => boolean)()).toBe(false);
      h.getCurrent.mockReturnValue({ marker: 'session', lock_state: 'locked' });
      expect((deps.isSessionLocked as () => boolean)()).toBe(true);
      h.getCurrent.mockReturnValue(null);
      expect((deps.isSessionLocked as () => boolean)()).toBe(false);

      expect(await (deps.pairedScope as () => Promise<unknown>)()).toEqual({
        tenantId: 'tenant-1',
        branchId: 'branch-1',
        terminalId: 'terminal-1',
      });
      h.getStatus.mockResolvedValue({ kind: 'unpaired' });
      expect(await (deps.pairedScope as () => Promise<unknown>)()).toBeNull();

      expect((deps.pairingEpoch as () => string | null)()).toBe('epoch-1');
      expect((deps.currentTerminalId as () => string | null)()).toBe('terminal-1');
      expect((deps.getManager as () => unknown)()).toBe('manager-identity');
      expect(m.managerIdentityOf).toHaveBeenCalledWith(null);
      expect(typeof deps.now).toBe('function');
      expect(Number.isNaN(Date.parse((deps.now as () => string)()))).toBe(false);
    },
  );

  it('passes the session-start hook straight to the operator session manager', () => {
    const h = makeHarness();
    registerShift(h.deps);
    const listener = vi.fn();
    (ipcDeps().onSessionStarted as (l: () => void) => void)(listener);
    expect(h.onStarted).toHaveBeenCalledWith(listener);
  });

  it('reports a cashier shift close to the updater (RT-772 safe point)', () => {
    const h = makeHarness();
    registerShift(h.deps);
    expect(h.notifyShiftClosed).not.toHaveBeenCalled();
    (ipcDeps().onShiftClosed as () => void)();
    expect(h.notifyShiftClosed).toHaveBeenCalledTimes(1);
  });

  it('registers the sync engine starter before the IPC handlers (original order)', () => {
    vi.stubEnv(FLAG, 'true');
    const order: string[] = [];
    const h = makeHarness();
    h.pairedWorkersRegister.mockImplementation(() => order.push('shift-sync engine'));
    m.registerShiftCashupIpc.mockImplementation(() => order.push('shift cash-up ipc'));
    registerShift(h.deps);
    expect(order).toEqual(['shift-sync engine', 'shift cash-up ipc']);
  });
});
