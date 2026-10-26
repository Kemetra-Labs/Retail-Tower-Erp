import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  composeSaleVoid: vi.fn(),
  scheduleSaleVoidSync: vi.fn(),
  registerSaleVoidHandlers: vi.fn(),
  createSaleSyncTokenReader: vi.fn(),
  createSaleAuditEmitter: vi.fn(),
  resolveApiBaseUrl: vi.fn(),
}));

vi.mock('../../sale-void/compose-sale-void.js', async (importActual) => {
  const actual = await importActual<typeof import('../../sale-void/compose-sale-void.js')>();
  return {
    ...actual,
    composeSaleVoid: m.composeSaleVoid,
    scheduleSaleVoidSync: m.scheduleSaleVoidSync,
  };
});
vi.mock('../../ipc/sale-void.js', () => ({ registerSaleVoidHandlers: m.registerSaleVoidHandlers }));
vi.mock('../../operator/sale-sync-token.js', () => ({
  createSaleSyncTokenReader: m.createSaleSyncTokenReader,
}));
vi.mock('../../sales/audit-emitter.js', () => ({
  createSaleAuditEmitter: m.createSaleAuditEmitter,
}));
vi.mock('../env.js', () => ({ resolveApiBaseUrl: m.resolveApiBaseUrl }));

import { SALE_VOID_DRAIN_TIMEOUT_MS } from '../../sale-void/compose-sale-void.js';
import { registerSaleVoid } from '../sale-void.js';
import type { SaleVoidDeps } from '../sale-void.js';

/**
 * RT-893 extraction 5 — the sale-void wiring moved verbatim out of `main/index.ts`. `index.ts`
 * cannot be imported under vitest (it runs `app.whenReady()` at module load), so the moved wiring
 * is pinned here directly, with every collaborator replaced by a recording fake and both states of
 * `POS_PULSE_FEATURE_SALE_VOID` exercised.
 */
const FLAG = 'POS_PULSE_FEATURE_SALE_VOID';

interface Harness {
  deps: SaleVoidDeps;
  workersRegister: ReturnType<typeof vi.fn>;
  getCurrent: ReturnType<typeof vi.fn>;
  getCurrentTerminalId: ReturnType<typeof vi.fn>;
  forwardAuditEvent: ReturnType<typeof vi.fn>;
  domain: { service: unknown; sync: unknown; stop: unknown };
}

function makeHarness(): Harness {
  const workersRegister = vi.fn();
  const getCurrent = vi.fn<() => unknown>(() => ({ lock_state: 'unlocked' }));
  const getCurrentTerminalId = vi.fn(() => 'terminal-1');
  const forwardAuditEvent = vi.fn();
  const domain = { service: { marker: 'service' }, sync: { marker: 'sync' }, stop: vi.fn() };
  m.composeSaleVoid.mockReturnValue(domain);
  const deps = {
    guardedIpcMain: { marker: 'guarded-ipc-main' },
    db: { marker: 'db' },
    backendFetch: vi.fn(),
    operatorSessionManager: { getCurrent },
    operatorEnvelopeHolder: { marker: 'envelope-holder' },
    pairingStore: { getCurrentTerminalId },
    managerApprovals: { marker: 'approvals' },
    auditEmitter: { marker: 'audit-emitter' },
    forwardAuditEvent,
    workerRegistry: { register: workersRegister },
    mainLogger: { marker: 'logger' },
    saleVoidRef: { current: null },
  } as unknown as SaleVoidDeps;
  return { deps, workersRegister, getCurrent, getCurrentTerminalId, forwardAuditEvent, domain };
}

function composed(): Record<string, unknown> {
  const call = m.composeSaleVoid.mock.calls.at(-1) as [Record<string, unknown>] | undefined;
  if (call === undefined) throw new Error('composeSaleVoid was not called');
  return call[0];
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.resolveApiBaseUrl.mockReturnValue('https://backend.example.test');
  m.createSaleSyncTokenReader.mockReturnValue('token-reader');
  m.createSaleAuditEmitter.mockReturnValue('access-audit');
  m.scheduleSaleVoidSync.mockReturnValue(() => Promise.resolve());
  vi.stubEnv(FLAG, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registerSaleVoid, flag off (the default)', () => {
  it('registers the handlers unconditionally and schedules no send', () => {
    const h = makeHarness();
    registerSaleVoid(h.deps);
    expect(m.registerSaleVoidHandlers).toHaveBeenCalledTimes(1);
    expect(m.registerSaleVoidHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      service: h.domain.service,
      logger: h.deps.mainLogger,
    });
    expect(m.scheduleSaleVoidSync).not.toHaveBeenCalled();
    expect(h.workersRegister).not.toHaveBeenCalled();
  });

  it.each(['', '0', 'false', 'off'])('treats %j as off', (raw) => {
    vi.stubEnv(FLAG, raw);
    const h = makeHarness();
    registerSaleVoid(h.deps);
    expect(m.scheduleSaleVoidSync).not.toHaveBeenCalled();
    expect(h.workersRegister).not.toHaveBeenCalled();
  });
});

describe('registerSaleVoid, flag on', () => {
  beforeEach(() => {
    vi.stubEnv(FLAG, 'true');
  });

  it('schedules the 5 s background send and registers its synchronous stop', () => {
    const h = makeHarness();
    const stop = vi.fn(() => Promise.resolve());
    m.scheduleSaleVoidSync.mockReturnValue(stop);
    registerSaleVoid(h.deps);

    expect(m.scheduleSaleVoidSync).toHaveBeenCalledWith({
      sync: h.domain.sync,
      stopDomain: h.domain.stop,
      intervalMs: 5_000,
      drainTimeoutMs: SALE_VOID_DRAIN_TIMEOUT_MS,
      logger: h.deps.mainLogger,
    });
    expect(h.workersRegister).toHaveBeenCalledTimes(1);
    expect(h.workersRegister.mock.calls[0]?.[0]).toBe('sale-void interval');
    const stopWorker = h.workersRegister.mock.calls[0]?.[1] as () => void;
    expect(stop).not.toHaveBeenCalled();
    stopWorker();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('registerSaleVoid composition (both flag states pass the same sources)', () => {
  it.each([undefined, 'true'])('wires the live session and terminal seams (flag %j)', (raw) => {
    vi.stubEnv(FLAG, raw);
    const h = makeHarness();
    registerSaleVoid(h.deps);
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
    expect(deps.approvals).toBe(h.deps.managerApprovals);
    expect(deps.auditSink).toBe(h.deps.auditEmitter);
    expect(deps.logger).toBe(h.deps.mainLogger);

    expect((deps.getSession as () => unknown)()).toEqual({ lock_state: 'unlocked' });
    expect((deps.getTerminalId as () => string | null)()).toBe('terminal-1');
    expect((deps.isSessionLocked as () => boolean)()).toBe(false);
    h.getCurrent.mockReturnValue({ lock_state: 'locked' });
    expect((deps.isSessionLocked as () => boolean)()).toBe(true);
    h.getCurrent.mockReturnValue(null);
    expect((deps.isSessionLocked as () => boolean)()).toBe(false);
    expect(Number.isNaN(Date.parse((deps.now as () => string)()))).toBe(false);
  });

  it('re-reads the flag on every call (isEnabled follows it)', () => {
    const h = makeHarness();
    registerSaleVoid(h.deps);
    const isEnabled = composed().isEnabled as () => boolean;
    expect(isEnabled()).toBe(false);
    vi.stubEnv(FLAG, 'true');
    expect(isEnabled()).toBe(true);
  });

  it('writes the RT-741 access audit through the forwarded audit sink', () => {
    const h = makeHarness();
    registerSaleVoid(h.deps);
    expect(composed().accessAudit).toBe('access-audit');
    const emitterDeps = m.createSaleAuditEmitter.mock.calls[0]?.[0] as {
      sink: { write: (evt: unknown) => void };
    };
    const evt = { marker: 'event' };
    emitterDeps.sink.write(evt);
    expect(h.forwardAuditEvent).toHaveBeenCalledWith(evt);
  });

  it("binds the domain into the approval subject's ref before the handlers are registered", () => {
    const h = makeHarness();
    m.registerSaleVoidHandlers.mockImplementation(() => {
      expect(h.deps.saleVoidRef.current).toBe(h.domain);
    });
    expect(h.deps.saleVoidRef.current).toBeNull();
    registerSaleVoid(h.deps);
    expect(h.deps.saleVoidRef.current).toBe(h.domain);
    expect(m.registerSaleVoidHandlers).toHaveBeenCalledTimes(1);
  });
});
