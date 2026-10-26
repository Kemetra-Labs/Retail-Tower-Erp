import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createSaleSyncStateRepo: vi.fn(),
  createSaleSyncClient: vi.fn(),
  createSaleSyncEngine: vi.fn(),
  createSaleSyncStatusReader: vi.fn(),
  createTerminalSyncAggregateReader: vi.fn(),
  composeSaleSyncDevicePath: vi.fn(),
  createCurrentTerminalResolver: vi.fn(),
  createSaleSyncTokenReader: vi.fn(),
  createSendableDeviceTokenRead: vi.fn(),
  registerSalesSyncHandlers: vi.fn(),
  resetCashierClaimRefusedOnStart: vi.fn(),
  isCashierClaimRefusedResetRequested: vi.fn(),
  logSaleSyncPauseTransition: vi.fn(),
  parseTendersSince: vi.fn(),
  parseReceiptSince: vi.fn(),
  scheduleSaleSync: vi.fn(),
  resolveApiBaseUrl: vi.fn(),
  createDiscountRoleResolver: vi.fn(),
  auditEmit: vi.fn(),
  bindAuditEventsStoreDb: vi.fn(),
}));

vi.mock('../../sales-sync/sale-sync-state-repo.js', () => ({
  createSaleSyncStateRepo: m.createSaleSyncStateRepo,
}));
vi.mock('../../sales-sync/create-sale-sync-client.js', () => ({
  createSaleSyncClient: m.createSaleSyncClient,
}));
vi.mock('../../sales-sync/sale-sync-engine.js', () => ({
  createSaleSyncEngine: m.createSaleSyncEngine,
  logSaleSyncPauseTransition: m.logSaleSyncPauseTransition,
  SALE_SYNC_BACKOFF_POLICY: { baseMs: 1_000, maxMs: 300_000 },
}));
vi.mock('../../sales-sync/sale-sync-status-reader.js', () => ({
  createSaleSyncStatusReader: m.createSaleSyncStatusReader,
}));
vi.mock('../../terminal-status/sync-aggregate.js', () => ({
  createTerminalSyncAggregateReader: m.createTerminalSyncAggregateReader,
}));
vi.mock('../../sales-sync/compose-device-path.js', () => ({
  composeSaleSyncDevicePath: m.composeSaleSyncDevicePath,
}));
vi.mock('../../sales-sync/current-terminal.js', () => ({
  createCurrentTerminalResolver: m.createCurrentTerminalResolver,
}));
vi.mock('../../operator/sale-sync-token.js', () => ({
  createSaleSyncTokenReader: m.createSaleSyncTokenReader,
}));
vi.mock('../../pairing/device-token.js', () => ({
  createSendableDeviceTokenRead: m.createSendableDeviceTokenRead,
}));
vi.mock('../../ipc/sales-sync.js', () => ({
  registerSalesSyncHandlers: m.registerSalesSyncHandlers,
}));
vi.mock('../../sales-sync/cashier-claim-refused-reset.js', () => ({
  CASHIER_CLAIM_REFUSED_RESET_ENV: 'POS_PULSE_SUPPORT_RESET_CASHIER_CLAIM_REFUSED',
  isCashierClaimRefusedResetRequested: m.isCashierClaimRefusedResetRequested,
  resetCashierClaimRefusedOnStart: m.resetCashierClaimRefusedOnStart,
}));
vi.mock('../../sales-sync/capture-payload.js', () => ({
  parseTendersSince: m.parseTendersSince,
  parseReceiptSince: m.parseReceiptSince,
}));
vi.mock('../../sales-sync/schedule-sale-sync.js', () => ({
  SALE_SYNC_DRAIN_TIMEOUT_MS: 4_000,
  scheduleSaleSync: m.scheduleSaleSync,
}));
vi.mock('../env.js', () => ({ resolveApiBaseUrl: m.resolveApiBaseUrl }));
vi.mock('../../sales-sync/discount-role-resolver.js', () => ({
  createDiscountRoleResolver: m.createDiscountRoleResolver,
}));
vi.mock('../../audit/audit-events-store.js', () => ({
  bindAuditEventsStoreDb: m.bindAuditEventsStoreDb,
}));
vi.mock('../../audit/audit-emitter.js', () => ({
  AuditEmitter: class {
    constructor(readonly store: unknown) {}
    emit(event: unknown): void {
      m.auditEmit(this.store, event);
    }
  },
}));

import { startSaleSyncEngine } from '../sale-sync.js';
import type { SaleSyncDeps } from '../sale-sync.js';

/**
 * RT-900 extraction 6c — the 011 sale-sync engine wiring moved verbatim out of the paired-only
 * starter in `main/index.ts`. `index.ts` cannot be imported under vitest (it runs `app.whenReady()`
 * at module load), so the moved wiring is pinned here directly, with every collaborator replaced
 * by a recording fake.
 */
const TERMINAL = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };

interface Harness {
  deps: SaleSyncDeps;
  events: string[];
  stopSaleSync: ReturnType<typeof vi.fn>;
  workersRegister: ReturnType<typeof vi.fn>;
  setSyncReader: ReturnType<typeof vi.fn>;
  engine: { pausedReason: ReturnType<typeof vi.fn> };
  getStatus: ReturnType<typeof vi.fn>;
  logger: Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
}

function makeHarness(): Harness {
  const events: string[] = [];
  const stopSaleSync = vi.fn();
  const engine = { pausedReason: vi.fn(() => null) };
  const workersRegister = vi.fn(() => events.push('register'));
  const setSyncReader = vi.fn(() => events.push('syncReader'));
  const getCurrentTerminalId = vi.fn(() => 'terminal-1');
  const getStatus = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  m.createSaleSyncStateRepo.mockReturnValue({ marker: 'stateRepo' });
  m.composeSaleSyncDevicePath.mockReturnValue({
    client: { getDeviceToken: 'deviceTokenFn' },
    engine: { hasDeviceCredential: 'hasDeviceCredentialFn' },
  });
  m.createSendableDeviceTokenRead.mockReturnValue('sendableRead');
  m.createSaleSyncTokenReader.mockReturnValue('operatorTokenReader');
  m.createCurrentTerminalResolver.mockReturnValue('terminalResolver');
  m.createSaleSyncClient.mockReturnValue({ marker: 'client' });
  m.createSaleSyncEngine.mockImplementation(() => {
    events.push('engine');
    return engine;
  });
  m.createSaleSyncStatusReader.mockReturnValue('statusReader');
  m.createTerminalSyncAggregateReader.mockReturnValue('aggregateReader');
  m.registerSalesSyncHandlers.mockImplementation(() => events.push('statusHandler'));
  m.isCashierClaimRefusedResetRequested.mockReturnValue(false);
  m.resetCashierClaimRefusedOnStart.mockImplementation(() => events.push('reset'));
  m.parseTendersSince.mockReturnValue(null);
  m.parseReceiptSince.mockReturnValue(null);
  m.scheduleSaleSync.mockImplementation(() => {
    events.push('schedule');
    return stopSaleSync;
  });
  m.resolveApiBaseUrl.mockReturnValue('https://api.example.test');
  m.createDiscountRoleResolver.mockReturnValue({ marker: 'discountRoles' });
  m.bindAuditEventsStoreDb.mockReturnValue({ marker: 'auditStore' });
  const deps = {
    guardedIpcMain: { marker: 'ipcMain' },
    db: { marker: 'db' },
    salesRepo: { marker: 'salesRepo' },
    backendFetch: vi.fn(),
    operatorSessionManager: { marker: 'session' },
    operatorEnvelopeHolder: { marker: 'envelope' },
    pairingStore: { getCurrentTerminalId, getStatus },
    secretStore: { marker: 'secretStore' },
    deviceTokenKey: 'device-token-key',
    deviceAuthDetector: { observe: vi.fn() },
    terminalStatusPublisher: { setSyncReader },
    workerRegistry: { register: workersRegister },
    mainLogger: logger,
  } as unknown as SaleSyncDeps;
  return { deps, events, stopSaleSync, workersRegister, setSyncReader, engine, getStatus, logger };
}

function engineDeps(): Record<string, unknown> {
  return m.createSaleSyncEngine.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('startSaleSyncEngine (RT-900 extraction 6c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('POS_PULSE_FEATURE_SALE_TENDERS_SINCE', '');
    vi.stubEnv('POS_PULSE_FEATURE_SALE_RECEIPT_SINCE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('wires reset, engine, status handler, sync axis, then the interval and its stop, in order', () => {
    const h = makeHarness();
    startSaleSyncEngine(h.deps, TERMINAL);
    expect(h.events).toEqual([
      'reset',
      'engine',
      'statusHandler',
      'syncReader',
      'schedule',
      'register',
    ]);
    expect(h.workersRegister).toHaveBeenCalledWith('sale-sync interval', expect.any(Function));
    const stop = h.workersRegister.mock.calls[0]?.[1] as () => void;
    stop();
    expect(h.stopSaleSync).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith(
      { terminal_id: 'terminal-1' },
      'sale_sync_engine:started',
    );
  });

  it('builds the capture client on the backend fetch, the device path and both credentials', () => {
    const h = makeHarness();
    startSaleSyncEngine(h.deps, TERMINAL);
    expect(m.createSendableDeviceTokenRead).toHaveBeenCalledWith({
      pairingStore: h.deps.pairingStore,
      secretStore: h.deps.secretStore,
      deviceTokenKey: 'device-token-key',
    });
    const path = m.composeSaleSyncDevicePath.mock.calls[0]?.[0] as {
      db: unknown;
      readToken: unknown;
      currentTerminalId: () => string | null;
      deviceAuth: { fetch: unknown; detector: unknown };
      logger: unknown;
    };
    expect(path.db).toBe(h.deps.db);
    expect(path.readToken).toBe('sendableRead');
    expect(path.currentTerminalId()).toBe('terminal-1');
    expect(path.deviceAuth).toEqual({
      fetch: h.deps.backendFetch,
      detector: h.deps.deviceAuthDetector,
    });
    expect(path.logger).toBe(h.logger);
    expect(m.createSaleSyncTokenReader).toHaveBeenCalledWith(
      h.deps.operatorSessionManager,
      h.deps.operatorEnvelopeHolder,
    );
    const client = m.createSaleSyncClient.mock.calls[0]?.[0] as Record<string, unknown> & {
      onSaleRefUnavailable: (e: { externalId: string; reason: string }) => void;
    };
    expect(client['baseUrl']).toBe('https://api.example.test');
    expect(client['fetch']).toBe(h.deps.backendFetch);
    expect(client['getOperatorToken']).toBe('operatorTokenReader');
    expect(client['getDeviceToken']).toBe('deviceTokenFn');
    client.onSaleRefUnavailable({ externalId: 'ext-1', reason: 'missing' });
    expect(h.logger.warn).toHaveBeenCalledWith(
      { external_id: 'ext-1', reason: 'missing' },
      'sale_sync:sale_ref_unavailable',
    );
  });

  it('scopes the engine to the paired terminal and spreads the device-path engine deps', () => {
    const h = makeHarness();
    startSaleSyncEngine(h.deps, TERMINAL);
    const d = engineDeps();
    expect(d['tenantId']).toBe('tenant-1');
    expect(d['branchId']).toBe('branch-1');
    expect(d['salesRepo']).toBe(h.deps.salesRepo);
    expect(d['stateRepo']).toEqual({ marker: 'stateRepo' });
    expect(d['resolveTerminalId']).toBe('terminalResolver');
    expect(d['getOperatorToken']).toBe('operatorTokenReader');
    expect(d['hasDeviceCredential']).toBe('hasDeviceCredentialFn');
    expect(d['backoff']).toEqual({ baseMs: 1_000, maxMs: 300_000 });
    expect((d['now'] as () => string)()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const getStatus = m.createCurrentTerminalResolver.mock.calls[0]?.[0] as () => unknown;
    void getStatus();
    expect(h.getStatus).toHaveBeenCalledTimes(1);
  });

  it('passes the parsed tender and receipt cut-offs through, and warns when unparseable', () => {
    const h = makeHarness();
    vi.stubEnv('POS_PULSE_FEATURE_SALE_TENDERS_SINCE', 'garbage');
    vi.stubEnv('POS_PULSE_FEATURE_SALE_RECEIPT_SINCE', ' ');
    m.parseReceiptSince.mockReturnValueOnce('2027-01-01T00:00:00Z');
    startSaleSyncEngine(h.deps, TERMINAL);
    expect(m.parseTendersSince).toHaveBeenCalledWith('garbage');
    expect(engineDeps()['tendersSince']).toBeNull();
    expect(engineDeps()['receiptSince']).toBe('2027-01-01T00:00:00Z');
    expect(h.logger.warn).toHaveBeenCalledWith('sale_sync:tenders_since_unparseable_tenders_off');
    expect(h.logger.warn).not.toHaveBeenCalledWith(
      'sale_sync:receipt_since_unparseable_receipt_off',
    );

    const second = makeHarness();
    vi.stubEnv('POS_PULSE_FEATURE_SALE_TENDERS_SINCE', '');
    vi.stubEnv('POS_PULSE_FEATURE_SALE_RECEIPT_SINCE', 'nope');
    startSaleSyncEngine(second.deps, TERMINAL);
    expect(second.logger.warn).toHaveBeenCalledWith(
      'sale_sync:receipt_since_unparseable_receipt_off',
    );
    expect(second.logger.warn).not.toHaveBeenCalledWith(
      'sale_sync:tenders_since_unparseable_tenders_off',
    );
  });

  it('runs the RT-225 support reset for this terminal before the engine exists', () => {
    const h = makeHarness();
    m.isCashierClaimRefusedResetRequested.mockReturnValueOnce(true);
    startSaleSyncEngine(h.deps, TERMINAL);
    const reset = m.resetCashierClaimRefusedOnStart.mock.calls[0]?.[0] as {
      requested: boolean;
      stateRepo: unknown;
      scope: unknown;
      now: string;
      logger: unknown;
    };
    expect(reset.requested).toBe(true);
    expect(reset.stateRepo).toEqual({ marker: 'stateRepo' });
    expect(reset.scope).toEqual({
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      terminalId: 'terminal-1',
    });
    expect(reset.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(reset.logger).toBe(h.logger);
    expect(h.events.indexOf('reset')).toBeLessThan(h.events.indexOf('engine'));
  });

  it('RT-906: gives the engine the discount role resolver, auditing on the same handle', () => {
    const h = makeHarness();
    startSaleSyncEngine(h.deps, TERMINAL);
    expect(engineDeps()['discountRoles']).toEqual({ marker: 'discountRoles' });
    expect(m.bindAuditEventsStoreDb).toHaveBeenCalledWith(h.deps.db);
    const r = m.createDiscountRoleResolver.mock.calls[0]?.[0] as {
      db: unknown;
      emit: (event: { payload: Record<string, unknown> }) => void;
      now: () => string;
      newEventId: () => string;
    };
    expect(r.db).toBe(h.deps.db);
    expect(r.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(r.newEventId()).toMatch(/^[0-9a-f-]{36}$/);
    const event = { payload: { sale_id: 'sale-9', approver_role: 'manager' } };
    r.emit(event);
    expect(m.auditEmit).toHaveBeenCalledWith({ marker: 'auditStore' }, event);
    expect(h.logger.info).toHaveBeenCalledWith(
      { sale_id: 'sale-9' },
      'sale_sync:discount_role_resolved',
    );
  });

  it('logs the engine callbacks with opaque ids and closed-set reasons only', () => {
    const h = makeHarness();
    startSaleSyncEngine(h.deps, TERMINAL);
    const d = engineDeps() as unknown as {
      onDeadLetter: (id: string, reason?: string) => void;
      onSaleRefMismatch: (e: { externalId: string }) => void;
      onPayloadDivergence: (e: { externalId: string; errorCode: string }) => void;
      onPauseTransition: (e: unknown) => void;
    };
    d.onDeadLetter('sale-1', 'permanent');
    expect(h.logger.warn).toHaveBeenCalledWith(
      { sale_id: 'sale-1', reason: 'permanent' },
      'sale_sync:dead_letter',
    );
    d.onSaleRefMismatch({ externalId: 'ext-2' });
    expect(h.logger.warn).toHaveBeenCalledWith(
      { external_id: 'ext-2' },
      'sale_sync:sale_ref_mismatch',
    );
    d.onPayloadDivergence({ externalId: 'ext-3', errorCode: 'conflict' });
    expect(h.logger.warn).toHaveBeenCalledWith(
      { external_id: 'ext-3', error_code: 'conflict' },
      'sale_sync:payload_divergence',
    );
    const event = { kind: 'paused' };
    d.onPauseTransition(event);
    expect(m.logSaleSyncPauseTransition).toHaveBeenCalledWith(h.logger, event);
  });

  it('exposes the same queue read-only to the status handler and the terminal sync axis', () => {
    const h = makeHarness();
    startSaleSyncEngine(h.deps, TERMINAL);
    expect(m.registerSalesSyncHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      readStatus: 'statusReader',
    });
    const status = m.createSaleSyncStatusReader.mock.calls[0]?.[0] as {
      stateRepo: unknown;
      tenantId: string;
      branchId: string;
      resolveTerminalId: unknown;
      pausedReason: () => unknown;
    };
    expect(status.stateRepo).toEqual({ marker: 'stateRepo' });
    expect([status.tenantId, status.branchId]).toEqual(['tenant-1', 'branch-1']);
    expect(status.resolveTerminalId).toBe('terminalResolver');
    status.pausedReason();
    expect(h.engine.pausedReason).toHaveBeenCalledTimes(1);
    expect(h.setSyncReader).toHaveBeenCalledWith('aggregateReader');
    const aggregate = m.createTerminalSyncAggregateReader.mock.calls[0]?.[0] as {
      resolveTerminalId: unknown;
      pausedReason: () => unknown;
    };
    expect(aggregate.resolveTerminalId).toBe('terminalResolver');
    aggregate.pausedReason();
    expect(h.engine.pausedReason).toHaveBeenCalledTimes(2);
  });

  it('schedules the 5 s drain and latches the engine stopped from the stop callback', () => {
    const h = makeHarness();
    startSaleSyncEngine(h.deps, TERMINAL);
    const sched = m.scheduleSaleSync.mock.calls[0]?.[0] as {
      engine: unknown;
      latchStopped: () => void;
      intervalMs: number;
      drainTimeoutMs: number;
      logger: unknown;
    };
    expect(sched.engine).toBe(h.engine);
    expect(sched.intervalMs).toBe(5_000);
    expect(sched.drainTimeoutMs).toBe(4_000);
    expect(sched.logger).toBe(h.logger);
    const isStopped = engineDeps()['isStopped'] as () => boolean;
    expect(isStopped()).toBe(false);
    sched.latchStopped();
    expect(isStopped()).toBe(true);
  });
});
