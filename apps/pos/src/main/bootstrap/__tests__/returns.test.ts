import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

const m = vi.hoisted(() => ({
  composeReturns: vi.fn(),
  scheduleReturnsResolver: vi.fn(),
  registerReturnsHandlers: vi.fn(),
  createSaleSyncTokenReader: vi.fn(),
  resolveSessionScope: vi.fn(),
  resolveApiBaseUrl: vi.fn(),
}));

vi.mock('../../returns/compose-returns.js', async (importActual) => {
  const actual = await importActual<typeof import('../../returns/compose-returns.js')>();
  return {
    ...actual,
    composeReturns: m.composeReturns,
    scheduleReturnsResolver: m.scheduleReturnsResolver,
  };
});
vi.mock('../../ipc/returns.js', () => ({ registerReturnsHandlers: m.registerReturnsHandlers }));
vi.mock('../../operator/sale-sync-token.js', () => ({
  createSaleSyncTokenReader: m.createSaleSyncTokenReader,
}));
vi.mock('../../operator/resolve-session-scope.js', () => ({
  resolveSessionScope: m.resolveSessionScope,
}));
vi.mock('../env.js', () => ({ resolveApiBaseUrl: m.resolveApiBaseUrl }));

import { RETURNS_DRAIN_TIMEOUT_MS } from '../../returns/compose-returns.js';
import { registerReturns } from '../returns.js';
import type { ReturnsDeps } from '../returns.js';

/**
 * RT-893 extraction 5 — the returns wiring moved verbatim out of `main/index.ts`. `index.ts`
 * cannot be imported under vitest (it runs `app.whenReady()` at module load), so the moved wiring
 * is pinned here directly, with every collaborator replaced by a recording fake and both states of
 * `POS_PULSE_FEATURE_RETURNS` exercised.
 */
const FLAG = 'POS_PULSE_FEATURE_RETURNS';

interface Harness {
  deps: ReturnsDeps;
  workersRegister: ReturnType<typeof vi.fn>;
  getCurrent: Mock<() => unknown>;
  domain: { service: unknown; resolver: unknown; stop: unknown };
}

function makeHarness(): Harness {
  const workersRegister = vi.fn();
  const getCurrent = vi.fn<() => unknown>(() => ({ marker: 'session', lock_state: 'unlocked' }));
  const domain = {
    service: { marker: 'service' },
    resolver: { marker: 'resolver' },
    stop: vi.fn(),
  };
  m.composeReturns.mockReturnValue(domain);
  const deps = {
    guardedIpcMain: { marker: 'guarded-ipc-main' },
    db: { marker: 'db' },
    backendFetch: vi.fn(),
    operatorSessionManager: { getCurrent },
    operatorEnvelopeHolder: { marker: 'envelope-holder' },
    pairingStore: { getCurrentTerminalId: vi.fn(() => 'terminal-1') },
    auditEmitter: { marker: 'audit-emitter' },
    drawerKickTransport: { marker: 'drawer' },
    printPipeline: { marker: 'print-pipeline' },
    workerRegistry: { register: workersRegister },
    mainLogger: { marker: 'logger' },
  } as unknown as ReturnsDeps;
  return { deps, workersRegister, getCurrent, domain };
}

function composed(): Record<string, unknown> {
  const call = m.composeReturns.mock.calls.at(-1) as [Record<string, unknown>] | undefined;
  if (call === undefined) throw new Error('composeReturns was not called');
  return call[0];
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.resolveApiBaseUrl.mockReturnValue('https://backend.example.test');
  m.createSaleSyncTokenReader.mockReturnValue('token-reader');
  m.resolveSessionScope.mockReturnValue('session-scope');
  m.scheduleReturnsResolver.mockReturnValue(() => Promise.resolve());
  vi.stubEnv(FLAG, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registerReturns, flag off (the default)', () => {
  it('registers the handlers unconditionally and schedules no resolver', () => {
    const h = makeHarness();
    registerReturns(h.deps);
    expect(m.registerReturnsHandlers).toHaveBeenCalledTimes(1);
    expect(m.registerReturnsHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      service: h.domain.service,
    });
    expect(m.scheduleReturnsResolver).not.toHaveBeenCalled();
    expect(h.workersRegister).not.toHaveBeenCalled();
  });

  it.each(['', '0', 'false', 'off'])('treats %j as off', (raw) => {
    vi.stubEnv(FLAG, raw);
    const h = makeHarness();
    registerReturns(h.deps);
    expect(m.scheduleReturnsResolver).not.toHaveBeenCalled();
    expect(h.workersRegister).not.toHaveBeenCalled();
  });
});

describe('registerReturns, flag on', () => {
  beforeEach(() => {
    vi.stubEnv(FLAG, 'true');
  });

  it('schedules the 30 s resolver and registers its synchronous stop', () => {
    const h = makeHarness();
    const stop = vi.fn(() => Promise.resolve());
    m.scheduleReturnsResolver.mockReturnValue(stop);
    registerReturns(h.deps);

    expect(m.scheduleReturnsResolver).toHaveBeenCalledWith({
      resolver: h.domain.resolver,
      stopDomain: h.domain.stop,
      intervalMs: 30_000,
      drainTimeoutMs: RETURNS_DRAIN_TIMEOUT_MS,
      logger: h.deps.mainLogger,
    });
    expect(h.workersRegister).toHaveBeenCalledTimes(1);
    expect(h.workersRegister.mock.calls[0]?.[0]).toBe('returns resolver');
    const stopWorker = h.workersRegister.mock.calls[0]?.[1] as () => void;
    expect(stop).not.toHaveBeenCalled();
    stopWorker();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('registerReturns composition (both flag states pass the same sources)', () => {
  it.each([undefined, 'true'])(
    'wires the live session and shared hardware ports (flag %j)',
    (raw) => {
      vi.stubEnv(FLAG, raw);
      const h = makeHarness();
      registerReturns(h.deps);
      const deps = composed();

      expect(deps.db).toBe(h.deps.db);
      expect(deps.http).toEqual({
        baseUrl: 'https://backend.example.test',
        fetch: h.deps.backendFetch,
      });
      expect(deps.getOperatorEnvelope).toBe('token-reader');
      expect(m.createSaleSyncTokenReader).toHaveBeenCalledWith(
        h.deps.operatorSessionManager,
        h.deps.operatorEnvelopeHolder,
      );
      expect(deps.auditSink).toBe(h.deps.auditEmitter);
      expect(deps.logger).toBe(h.deps.mainLogger);
      // RT-15 S4: the SAME drawer port and print pipeline as sales.
      expect(deps.drawer).toBe(h.deps.drawerKickTransport);
      expect(deps.printer).toBe(h.deps.printPipeline);

      // getSession resolves the live operator session against the current terminal.
      expect((deps.getSession as () => unknown)()).toBe('session-scope');
      expect(m.resolveSessionScope).toHaveBeenCalledWith(h.getCurrent(), 'terminal-1');
      expect((deps.isSessionLocked as () => boolean)()).toBe(false);
      h.getCurrent.mockReturnValue({ lock_state: 'locked' });
      expect((deps.isSessionLocked as () => boolean)()).toBe(true);
      h.getCurrent.mockReturnValue(null);
      expect((deps.isSessionLocked as () => boolean)()).toBe(false);
      expect(Number.isNaN(Date.parse((deps.now as () => string)()))).toBe(false);
    },
  );

  it('re-reads the flag on every call (isEnabled follows it)', () => {
    const h = makeHarness();
    registerReturns(h.deps);
    const isEnabled = composed().isEnabled as () => boolean;
    expect(isEnabled()).toBe(false);
    vi.stubEnv(FLAG, 'true');
    expect(isEnabled()).toBe(true);
  });

  it('composes the domain before registering its handlers', () => {
    const order: string[] = [];
    const h = makeHarness();
    m.composeReturns.mockImplementation(() => {
      order.push('compose');
      return h.domain;
    });
    m.registerReturnsHandlers.mockImplementation(() => order.push('handlers'));
    registerReturns(h.deps);
    expect(order).toEqual(['compose', 'handlers']);
  });
});
