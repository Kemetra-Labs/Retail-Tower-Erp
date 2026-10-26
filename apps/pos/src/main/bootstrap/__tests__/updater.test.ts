import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    autoUpdater: { marker: 'auto-updater' },
    printActivity: { marker: 'print-activity' },
    gate: { marker: 'gate' },
    safePointInputs: { marker: 'safe-point-inputs' },
    verifier: { marker: 'verifier' },
    probe: { marker: 'probe' },
    service: {
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(),
      onStatusChange: vi.fn(),
      notifyShiftClosed: vi.fn(),
    },
    createUpdateService: vi.fn(),
    createPrintActivity: vi.fn(),
    createSafePointGate: vi.fn(),
    createSafePointInputs: vi.fn(),
    createFailClosedVerifier: vi.fn(),
    createPowerShellProbe: vi.fn(),
    resolveUpdateConfig: vi.fn(),
    readPublisherPins: vi.fn(),
    registerUpdateStatusHandlers: vi.fn(),
    wireUpdateStatusPush: vi.fn(),
    broadcastToWindows: vi.fn(),
  };
});

vi.mock('electron-updater', () => ({ default: { autoUpdater: m.autoUpdater } }));
vi.mock('../../update/update-service.js', () => ({ createUpdateService: m.createUpdateService }));
vi.mock('../../update/print-activity.js', () => ({ createPrintActivity: m.createPrintActivity }));
vi.mock('../../update/safe-point-gate.js', () => ({ createSafePointGate: m.createSafePointGate }));
vi.mock('../../update/safe-point-inputs.js', () => ({
  createSafePointInputs: m.createSafePointInputs,
}));
vi.mock('../../update/signature-verifier.js', () => ({
  createFailClosedVerifier: m.createFailClosedVerifier,
}));
vi.mock('../../update/powershell-signature-probe.js', () => ({
  createPowerShellProbe: m.createPowerShellProbe,
}));
vi.mock('../../update/update-config.js', () => ({
  resolveUpdateConfig: m.resolveUpdateConfig,
  readPublisherPins: m.readPublisherPins,
}));
vi.mock('../../ipc/update-status.js', () => ({
  registerUpdateStatusHandlers: m.registerUpdateStatusHandlers,
  wireUpdateStatusPush: m.wireUpdateStatusPush,
}));
vi.mock('../window.js', () => ({ broadcastToWindows: m.broadcastToWindows }));

import { registerUpdater, startUpdater } from '../updater.js';
import type { UpdaterDeps } from '../updater.js';

/**
 * RT-893 extraction 2 — the updater wiring moved verbatim out of `main/index.ts`.
 * `index.ts` cannot be imported under vitest (it runs `app.whenReady()` at module load), so the
 * moved wiring is pinned here directly, with every collaborator replaced by a recording fake.
 */
const RESOURCES_PATH = path.join('C:', 'fake', 'resources');
const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;

function makeDeps(overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    guardedIpcMain: { handle: vi.fn() } as unknown as UpdaterDeps['guardedIpcMain'],
    db: { marker: 'db' } as unknown as UpdaterDeps['db'],
    shippedApp: true,
    operatorSessionManager: { getCurrent: vi.fn(() => null) },
    mainLogger: { info: vi.fn(), warn: vi.fn() } as unknown as UpdaterDeps['mainLogger'],
    ...overrides,
  };
}

function lastServiceDeps(): Record<string, unknown> {
  const call = m.createUpdateService.mock.calls.at(-1) as [Record<string, unknown>] | undefined;
  if (call === undefined) throw new Error('createUpdateService was not called');
  return call[0];
}

beforeEach(() => {
  m.calls.length = 0;
  for (const fn of [
    m.createUpdateService,
    m.createPrintActivity,
    m.createSafePointGate,
    m.createSafePointInputs,
    m.createFailClosedVerifier,
    m.createPowerShellProbe,
    m.resolveUpdateConfig,
    m.readPublisherPins,
    m.registerUpdateStatusHandlers,
    m.wireUpdateStatusPush,
    m.broadcastToWindows,
    m.service.start,
    m.service.getStatus,
    m.service.onStatusChange,
  ]) {
    fn.mockReset();
  }
  m.createPrintActivity.mockReturnValue(m.printActivity);
  m.createSafePointInputs.mockReturnValue(m.safePointInputs);
  m.createSafePointGate.mockReturnValue(m.gate);
  m.createPowerShellProbe.mockReturnValue(m.probe);
  m.createFailClosedVerifier.mockReturnValue(m.verifier);
  m.resolveUpdateConfig.mockReturnValue({ origin: 'https://updates.example.test', channel: 'lab' });
  m.readPublisherPins.mockReturnValue(['pin-a']);
  m.createUpdateService.mockImplementation(() => {
    m.calls.push('createUpdateService');
    return m.service;
  });
  m.registerUpdateStatusHandlers.mockImplementation(() => {
    m.calls.push('registerUpdateStatusHandlers');
  });
  m.wireUpdateStatusPush.mockImplementation(() => {
    m.calls.push('wireUpdateStatusPush');
    return () => undefined;
  });
  (process as { resourcesPath?: string }).resourcesPath = RESOURCES_PATH;
});

afterEach(() => {
  if (originalResourcesPath === undefined) {
    delete (process as { resourcesPath?: string }).resourcesPath;
  } else {
    (process as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  }
});

describe('registerUpdater', () => {
  it('returns the service and the print activity it built, and starts nothing', () => {
    const wiring = registerUpdater(makeDeps());
    expect(wiring.updateService).toBe(m.service);
    expect(wiring.printActivity).toBe(m.printActivity);
    expect(m.service.start).not.toHaveBeenCalled();
  });

  it('builds the service from the configured origin and channel, the shipped-app flag and the logger', () => {
    const deps = makeDeps({ shippedApp: false });
    registerUpdater(deps);
    expect(m.resolveUpdateConfig).toHaveBeenCalledWith(process.env);
    const service = lastServiceDeps();
    expect(service['isShippedApp']).toBe(false);
    expect(service['origin']).toBe('https://updates.example.test');
    expect(service['channel']).toBe('lab');
    expect(service['logger']).toBe(deps.mainLogger);
    expect(service['afterShiftCloseDelayMs']).toBe(4_000);
  });

  it('gates the install on the safe-point inputs read from the db and the same print activity', () => {
    const deps = makeDeps();
    registerUpdater(deps);
    expect(m.createSafePointInputs).toHaveBeenCalledWith(deps.db, m.printActivity);
    expect(m.createSafePointGate).toHaveBeenCalledWith(m.safePointInputs);
    expect(lastServiceDeps()['gate']).toBe(m.gate);
  });

  it('verifies signatures with the fail-closed verifier over the PowerShell probe', () => {
    registerUpdater(makeDeps());
    expect(m.createFailClosedVerifier).toHaveBeenCalledWith(m.probe);
    expect(lastServiceDeps()['verifier']).toBe(m.verifier);
  });

  it('touches the electron-updater singleton and the pin file only when the service asks', () => {
    registerUpdater(makeDeps());
    expect(m.readPublisherPins).not.toHaveBeenCalled();
    const service = lastServiceDeps() as {
      getUpdater: () => unknown;
      readPublisherPins: () => readonly string[];
    };
    expect(service.getUpdater()).toBe(m.autoUpdater);
    expect(service.readPublisherPins()).toEqual(['pin-a']);
    expect(m.readPublisherPins).toHaveBeenCalledWith(path.join(RESOURCES_PATH, 'app-update.yml'));
  });

  it('reports "before sign-in" exactly while the operator session holder has no current session', () => {
    const getCurrent = vi.fn<() => unknown>(() => null);
    registerUpdater(makeDeps({ operatorSessionManager: { getCurrent } as never }));
    const isBeforeSignIn = lastServiceDeps()['isBeforeSignIn'] as () => boolean;
    expect(isBeforeSignIn()).toBe(true);
    getCurrent.mockReturnValue({ session: 'current' });
    expect(isBeforeSignIn()).toBe(false);
  });

  it('registers the read-only status bridge on the guarded ipcMain, reading the live status', () => {
    const deps = makeDeps();
    registerUpdater(deps);
    expect(m.registerUpdateStatusHandlers).toHaveBeenCalledTimes(1);
    const [ipc, handlerDeps] = m.registerUpdateStatusHandlers.mock.calls[0] as [
      unknown,
      { read: () => unknown },
    ];
    expect(ipc).toBe(deps.guardedIpcMain);
    const status = { state: 'idle' };
    m.service.getStatus.mockReturnValue(status);
    expect(handlerDeps.read()).toBe(status);
    expect(Object.keys(handlerDeps)).toEqual(['read']);
  });

  it('pushes status changes to the app windows on updateStatus:changed', () => {
    registerUpdater(makeDeps());
    expect(m.wireUpdateStatusPush).toHaveBeenCalledTimes(1);
    const [pushDeps] = m.wireUpdateStatusPush.mock.calls[0] as [
      {
        subscribe: (listener: (s: unknown) => void) => unknown;
        send: (snapshot: unknown) => void;
      },
    ];

    const listener = vi.fn();
    const unsubscribe = (): void => undefined;
    m.service.onStatusChange.mockReturnValue(unsubscribe);
    expect(pushDeps.subscribe(listener)).toBe(unsubscribe);
    expect(m.service.onStatusChange).toHaveBeenCalledWith(listener);

    const snapshot = { v: 1, state: 'idle' };
    pushDeps.send(snapshot);
    expect(m.broadcastToWindows).toHaveBeenCalledWith('updateStatus:changed', snapshot);
  });

  it('keeps the boot order: service, then the status handlers, then the push wiring', () => {
    registerUpdater(makeDeps());
    expect(m.calls).toEqual([
      'createUpdateService',
      'registerUpdateStatusHandlers',
      'wireUpdateStatusPush',
    ]);
    expect(m.createPrintActivity.mock.invocationCallOrder[0]).toBeLessThan(
      m.createUpdateService.mock.invocationCallOrder[0] as number,
    );
  });
});

describe('startUpdater', () => {
  it('starts the service once', () => {
    startUpdater({ updateService: m.service });
    expect(m.service.start).toHaveBeenCalledTimes(1);
  });
});
