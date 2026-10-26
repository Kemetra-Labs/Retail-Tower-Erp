import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  bindSalesRepository: vi.fn(),
  bindPrintEventsRepository: vi.fn(),
  bindDrawerEventsRepository: vi.fn(),
  createSaleVoidRepository: vi.fn(),
  createSaleAuditEmitter: vi.fn(),
  createSalesBridge: vi.fn(),
  bindBannerStateProjector: vi.fn(),
  registerSalesHandlers: vi.fn(),
  createPrintDispatcher: vi.fn(),
  createDrawerKickDispatcher: vi.fn(),
  createReceiptsBridge: vi.fn(),
  registerReceiptsHandlers: vi.fn(),
  createSaleHistoryService: vi.fn(),
  createSaleHistoryCredentialResolver: vi.fn(),
  createSaleHistoryClient: vi.fn(),
  createSaleHistoryLocalReads: vi.fn(),
  createStoreZoneMonitor: vi.fn(),
  registerSaleHistoryHandlers: vi.fn(),
  createSendableDeviceTokenRead: vi.fn(),
  resolveSessionScope: vi.fn(),
  resolveApiBaseUrl: vi.fn(),
}));

vi.mock('../../sales/repositories/sales.repository.js', () => ({
  bindSalesRepository: m.bindSalesRepository,
}));
vi.mock('../../sales/repositories/print-events.repository.js', () => ({
  bindPrintEventsRepository: m.bindPrintEventsRepository,
}));
vi.mock('../../sales/repositories/drawer-events.repository.js', () => ({
  bindDrawerEventsRepository: m.bindDrawerEventsRepository,
}));
vi.mock('../../sale-void/sale-void-repository.js', () => ({
  createSaleVoidRepository: m.createSaleVoidRepository,
}));
vi.mock('../../sales/audit-emitter.js', () => ({
  createSaleAuditEmitter: m.createSaleAuditEmitter,
}));
vi.mock('../../sales/sales-bridge.js', () => ({ createSalesBridge: m.createSalesBridge }));
vi.mock('../../sales/banner-state-projector.js', () => ({
  bindBannerStateProjector: m.bindBannerStateProjector,
}));
vi.mock('../../ipc/sales.js', () => ({ registerSalesHandlers: m.registerSalesHandlers }));
vi.mock('../../receipts/print-dispatcher.js', () => ({
  createPrintDispatcher: m.createPrintDispatcher,
}));
vi.mock('../../drawer/drawer-kick.js', () => ({
  createDrawerKickDispatcher: m.createDrawerKickDispatcher,
}));
vi.mock('../../receipts/receipts-bridge.js', () => ({
  createReceiptsBridge: m.createReceiptsBridge,
}));
vi.mock('../../ipc/receipts.js', () => ({ registerReceiptsHandlers: m.registerReceiptsHandlers }));
vi.mock('../../sale-history/sale-history-service.js', () => ({
  createSaleHistoryService: m.createSaleHistoryService,
}));
vi.mock('../../sale-history/sale-history-credential.js', () => ({
  createSaleHistoryCredentialResolver: m.createSaleHistoryCredentialResolver,
}));
vi.mock('../../sale-history/sale-history-client.js', () => ({
  createSaleHistoryClient: m.createSaleHistoryClient,
}));
vi.mock('../../sale-history/sale-history-local.js', () => ({
  createSaleHistoryLocalReads: m.createSaleHistoryLocalReads,
}));
vi.mock('../../sale-history/store-zone-monitor.js', () => ({
  createStoreZoneMonitor: m.createStoreZoneMonitor,
}));
vi.mock('../../ipc/sale-history.js', () => ({
  registerSaleHistoryHandlers: m.registerSaleHistoryHandlers,
}));
vi.mock('../../pairing/device-token.js', () => ({
  createSendableDeviceTokenRead: m.createSendableDeviceTokenRead,
}));
vi.mock('../../operator/resolve-session-scope.js', () => ({
  resolveSessionScope: m.resolveSessionScope,
}));
vi.mock('../env.js', () => ({ resolveApiBaseUrl: m.resolveApiBaseUrl }));

import { registerSalesBridges } from '../sales-bridges.js';
import type { SalesBridgesDeps } from '../sales-bridges.js';

/**
 * RT-893 extraction 6a — the `sales.*`, `receipts.*` and sale-history wiring moved verbatim out of
 * `main/index.ts`. `index.ts` cannot be imported under vitest (it runs `app.whenReady()` at module
 * load), so the moved wiring is pinned here directly, with every collaborator replaced by a
 * recording fake.
 */
type Fn = (...args: unknown[]) => unknown;

interface Harness {
  deps: SalesBridgesDeps;
  getCurrent: ReturnType<typeof vi.fn>;
  getCurrentTerminalId: ReturnType<typeof vi.fn>;
  chosenPrinterName: ReturnType<typeof vi.fn>;
  forwardAuditEvent: ReturnType<typeof vi.fn>;
  liveForSale: ReturnType<typeof vi.fn>;
  envelopeGet: ReturnType<typeof vi.fn>;
  fakes: {
    salesRepo: object;
    printEventsRepo: object;
    drawerEventsRepo: object;
    saleAuditEmitter: object;
    salesBridge: object;
    receiptsBridge: object;
    printDispatcher: object;
    drawerKickDispatcher: object;
    historyService: object;
  };
}

function makeHarness(): Harness {
  const getCurrent = vi.fn<() => unknown>(() => ({ marker: 'session', lock_state: 'unlocked' }));
  const getCurrentTerminalId = vi.fn(() => 'terminal-1');
  const chosenPrinterName = vi.fn<() => string | undefined>(() => undefined);
  const forwardAuditEvent = vi.fn();
  const liveForSale = vi.fn<(saleId: string) => unknown>(() => null);
  const envelopeGet = vi.fn(() => 'envelope');
  const fakes = {
    salesRepo: { marker: 'salesRepo' },
    printEventsRepo: { marker: 'printEventsRepo' },
    drawerEventsRepo: { marker: 'drawerEventsRepo' },
    saleAuditEmitter: { marker: 'saleAuditEmitter' },
    salesBridge: { marker: 'salesBridge' },
    receiptsBridge: { marker: 'receiptsBridge' },
    printDispatcher: { marker: 'printDispatcher' },
    drawerKickDispatcher: { marker: 'drawerKickDispatcher' },
    historyService: { marker: 'historyService' },
  };
  m.bindSalesRepository.mockReturnValue(fakes.salesRepo);
  m.bindPrintEventsRepository.mockReturnValue(fakes.printEventsRepo);
  m.bindDrawerEventsRepository.mockReturnValue(fakes.drawerEventsRepo);
  m.createSaleVoidRepository.mockReturnValue({ liveForSale });
  m.createSaleAuditEmitter.mockReturnValue(fakes.saleAuditEmitter);
  m.createSalesBridge.mockReturnValue(fakes.salesBridge);
  m.createReceiptsBridge.mockReturnValue(fakes.receiptsBridge);
  m.createPrintDispatcher.mockReturnValue(fakes.printDispatcher);
  m.createDrawerKickDispatcher.mockReturnValue(fakes.drawerKickDispatcher);
  m.createSaleHistoryService.mockReturnValue(fakes.historyService);
  m.bindBannerStateProjector.mockReturnValue({ marker: 'projector' });
  m.createSaleHistoryCredentialResolver.mockReturnValue({ marker: 'resolver' });
  m.createSaleHistoryClient.mockReturnValue({ marker: 'client' });
  m.createSaleHistoryLocalReads.mockReturnValue({ marker: 'local' });
  m.createStoreZoneMonitor.mockReturnValue({ marker: 'zone' });
  m.createSendableDeviceTokenRead.mockReturnValue(vi.fn());
  m.resolveSessionScope.mockReturnValue({ marker: 'scope' });
  m.resolveApiBaseUrl.mockReturnValue('https://api.example.test');
  const deps = {
    guardedIpcMain: { marker: 'guarded-ipc-main' },
    db: { marker: 'db' },
    backendFetch: vi.fn(),
    operatorSessionManager: { getCurrent },
    operatorEnvelopeHolder: { get: envelopeGet },
    pairingStore: { getCurrentTerminalId, getStatus: vi.fn() },
    secretStore: { get: vi.fn() },
    deviceTokenKey: 'terminal.device-token',
    forwardAuditEvent,
    printPipeline: { marker: 'printPipeline' },
    chosenPrinterName,
    drawerKickTransport: { kick: vi.fn() },
    mainLogger: { marker: 'logger' },
  } as unknown as SalesBridgesDeps;
  return {
    deps,
    getCurrent,
    getCurrentTerminalId,
    chosenPrinterName,
    forwardAuditEvent,
    liveForSale,
    envelopeGet,
    fakes,
  };
}

// The type parameter is the call-site's description of the recorded argument (a test-only cast).
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function firstArg<T>(mock: ReturnType<typeof vi.fn>): T {
  return mock.mock.calls[0]?.[0] as T;
}

describe('registerSalesBridges (RT-893 extraction 6a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the handles the paired finalize closure in index.ts reuses', () => {
    const h = makeHarness();
    const out = registerSalesBridges(h.deps);
    expect(out.salesRepo).toBe(h.fakes.salesRepo);
    expect(out.saleAuditEmitter).toBe(h.fakes.saleAuditEmitter);
    expect(out.printDispatcher).toBe(h.fakes.printDispatcher);
    expect(out.drawerKickDispatcher).toBe(h.fakes.drawerKickDispatcher);
  });

  it('binds the three repositories and the void journal to the database handle', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    for (const bind of [
      m.bindSalesRepository,
      m.bindPrintEventsRepository,
      m.bindDrawerEventsRepository,
      m.createSaleVoidRepository,
      m.bindBannerStateProjector,
      m.createSaleHistoryLocalReads,
    ]) {
      expect(bind).toHaveBeenCalledTimes(1);
      expect(bind).toHaveBeenCalledWith(h.deps.db);
    }
  });

  it('registers the sales, receipts and sale-history handlers once each, in that order', () => {
    const h = makeHarness();
    const order: string[] = [];
    m.registerSalesHandlers.mockImplementation(() => order.push('sales'));
    m.registerReceiptsHandlers.mockImplementation(() => order.push('receipts'));
    m.registerSaleHistoryHandlers.mockImplementation(() => order.push('sale-history'));
    registerSalesBridges(h.deps);
    expect(order).toEqual(['sales', 'receipts', 'sale-history']);
    expect(m.registerSalesHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      salesBridge: h.fakes.salesBridge,
    });
    expect(m.registerReceiptsHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      receiptsBridge: h.fakes.receiptsBridge,
    });
    expect(m.registerSaleHistoryHandlers).toHaveBeenCalledWith(h.deps.guardedIpcMain, {
      service: h.fakes.historyService,
      logger: h.deps.mainLogger,
    });
  });

  it('shares one audit emitter, session reader and lock check across the bridges', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    expect(m.createSaleAuditEmitter).toHaveBeenCalledTimes(1);
    const sink = firstArg<{ sink: { write: unknown } }>(m.createSaleAuditEmitter).sink;
    expect(sink.write).toBe(h.forwardAuditEvent);

    const sales = firstArg<Record<string, Fn>>(m.createSalesBridge);
    const receipts = firstArg<Record<string, Fn>>(m.createReceiptsBridge);
    const history = firstArg<Record<string, Fn>>(m.createSaleHistoryService);
    expect(sales['auditEmitter']).toBe(h.fakes.saleAuditEmitter);
    expect(receipts['auditEmitter']).toBe(h.fakes.saleAuditEmitter);
    expect(history['auditEmitter']).toBe(h.fakes.saleAuditEmitter);
    expect(receipts['getCurrentSession']).toBe(sales['getCurrentSession']);
    expect(history['getCurrentSession']).toBe(sales['getCurrentSession']);
    expect(receipts['isSessionLocked']).toBe(sales['isSessionLocked']);
    expect(history['isSessionLocked']).toBe(sales['isSessionLocked']);
  });

  it('resolves the sales session from the live session and the paired terminal id', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    const getSession = firstArg<{ getCurrentSession: () => unknown }>(
      m.createSalesBridge,
    ).getCurrentSession;
    expect(getSession()).toEqual({ marker: 'scope' });
    expect(m.resolveSessionScope).toHaveBeenCalledWith(
      { marker: 'session', lock_state: 'unlocked' },
      'terminal-1',
    );
  });

  it('reports a locked session through isSessionLocked and nothing else', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    const isLocked = firstArg<{ isSessionLocked: () => boolean }>(
      m.createSalesBridge,
    ).isSessionLocked;
    expect(isLocked()).toBe(false);
    h.getCurrent.mockReturnValue({ lock_state: 'locked' });
    expect(isLocked()).toBe(true);
    h.getCurrent.mockReturnValue(null);
    expect(isLocked()).toBe(false);
  });

  it('gives the sales bridge a snapshot projector and a fresh subscription token each call', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    const bridge = firstArg<{
      bannerStateProjector: unknown;
      newSubscriptionToken: () => string;
      salesRepo: unknown;
      printEventsRepo: unknown;
      drawerEventsRepo: unknown;
    }>(m.createSalesBridge);
    expect(bridge.bannerStateProjector).toEqual({ marker: 'projector' });
    expect(bridge.salesRepo).toBe(h.fakes.salesRepo);
    expect(bridge.printEventsRepo).toBe(h.fakes.printEventsRepo);
    expect(bridge.drawerEventsRepo).toBe(h.fakes.drawerEventsRepo);
    const a = bridge.newSubscriptionToken();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridge.newSubscriptionToken()).not.toBe(a);
  });

  it('builds the print dispatcher on the shared pipeline and reports the printer source', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    const dispatcher = firstArg<{
      pipeline: unknown;
      printEventsRepo: unknown;
      auditEmitter: unknown;
      logger: unknown;
      now: () => string;
      newPrintEventId: () => string;
      printerSource: () => string;
    }>(m.createPrintDispatcher);
    expect(dispatcher.pipeline).toBe(h.deps.printPipeline);
    expect(dispatcher.printEventsRepo).toBe(h.fakes.printEventsRepo);
    expect(dispatcher.auditEmitter).toBe(h.fakes.saleAuditEmitter);
    expect(dispatcher.logger).toBe(h.deps.mainLogger);
    expect(dispatcher.newPrintEventId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(dispatcher.printerSource()).toBe('os_default');
    h.chosenPrinterName.mockReturnValue('BIXOLON SRP-330II');
    expect(dispatcher.printerSource()).toBe('chosen');
  });

  it('uses one clock for the print dispatcher and the receipts bridge', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    const dispatcher = firstArg<{ now: () => string }>(m.createPrintDispatcher);
    const receipts = firstArg<{ now: () => string }>(m.createReceiptsBridge);
    expect(receipts.now).toBe(dispatcher.now);
    expect(dispatcher.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('builds the drawer-kick dispatcher on the shared drawer transport', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    const drawer = firstArg<{
      drawerEventsRepo: unknown;
      transport: unknown;
      auditEmitter: unknown;
      logger: unknown;
      now: () => string;
      newDrawerEventId: () => string;
    }>(m.createDrawerKickDispatcher);
    expect(drawer.drawerEventsRepo).toBe(h.fakes.drawerEventsRepo);
    expect(drawer.transport).toBe(h.deps.drawerKickTransport);
    expect(drawer.auditEmitter).toBe(h.fakes.saleAuditEmitter);
    expect(drawer.logger).toBe(h.deps.mainLogger);
    expect(drawer.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(drawer.newDrawerEventId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('wires the receipts bridge to both dispatchers and the void guard', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    const receipts = firstArg<{
      salesRepo: unknown;
      printEventsRepo: unknown;
      printDispatcher: unknown;
      drawerKickDispatcher: unknown;
      newPrintEventId: () => string;
      isSaleVoided: (saleId: string) => boolean;
    }>(m.createReceiptsBridge);
    expect(receipts.salesRepo).toBe(h.fakes.salesRepo);
    expect(receipts.printEventsRepo).toBe(h.fakes.printEventsRepo);
    expect(receipts.printDispatcher).toBe(h.fakes.printDispatcher);
    expect(receipts.drawerKickDispatcher).toBe(h.fakes.drawerKickDispatcher);
    expect(receipts.newPrintEventId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipts.isSaleVoided('sale-1')).toBe(false);
    h.liveForSale.mockReturnValue({ void_id: 'v1' });
    expect(receipts.isSaleVoided('sale-1')).toBe(true);
    expect(h.liveForSale).toHaveBeenCalledWith('sale-1');
  });

  it('builds the sale-history credential reader from the envelope holder and the device token', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    expect(m.createSendableDeviceTokenRead).toHaveBeenCalledWith({
      pairingStore: h.deps.pairingStore,
      secretStore: h.deps.secretStore,
      deviceTokenKey: 'terminal.device-token',
    });
    const resolver = firstArg<{
      getSessionRecord: () => unknown;
      getEnvelope: (id: string) => unknown;
      readDeviceToken: unknown;
    }>(m.createSaleHistoryCredentialResolver);
    expect(resolver.getSessionRecord()).toEqual({ marker: 'session', lock_state: 'unlocked' });
    expect(resolver.getEnvelope('backend-session-1')).toBe('envelope');
    expect(h.envelopeGet).toHaveBeenCalledWith('backend-session-1');
    expect(resolver.readDeviceToken).toBe(m.createSendableDeviceTokenRead.mock.results[0]?.value);
  });

  it('builds the sale-history client on the backend fetch and the resolved API base url', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    expect(m.createSaleHistoryClient).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.test',
      fetch: h.deps.backendFetch,
    });
  });

  it('assembles the sale-history service from the shared handles', () => {
    const h = makeHarness();
    registerSalesBridges(h.deps);
    const history = firstArg<{
      resolveCredential: unknown;
      client: unknown;
      local: unknown;
      salesRepo: unknown;
      printEventsRepo: unknown;
      printer: unknown;
      storeZone: unknown;
      now: () => string;
      isSaleVoided: (saleId: string) => boolean;
      newIdempotencyKey: () => string;
    }>(m.createSaleHistoryService);
    expect(history.resolveCredential).toEqual({ marker: 'resolver' });
    expect(history.client).toEqual({ marker: 'client' });
    expect(history.local).toEqual({ marker: 'local' });
    expect(history.salesRepo).toBe(h.fakes.salesRepo);
    expect(history.printEventsRepo).toBe(h.fakes.printEventsRepo);
    expect(history.printer).toBe(h.deps.printPipeline);
    expect(history.storeZone).toEqual({ marker: 'zone' });
    expect(m.createStoreZoneMonitor).toHaveBeenCalledWith({ logger: h.deps.mainLogger });
    expect(history.now).toBe(firstArg<{ now: () => string }>(m.createPrintDispatcher).now);
    expect(history.newIdempotencyKey()).toMatch(/^pos-pulse-reprint:[0-9a-f-]{36}$/);
    expect(history.isSaleVoided('sale-9')).toBe(false);
    h.liveForSale.mockReturnValue({ void_id: 'v9' });
    expect(history.isSaleVoided('sale-9')).toBe(true);
  });
});
