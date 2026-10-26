import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';
import type { DatabaseHandle } from '../db/client.js';
import type { DrawerKickTransport } from '../drawer/drawer-kick-transport.js';
import { createDrawerKickDispatcher } from '../drawer/drawer-kick.js';
import { registerReceiptsHandlers } from '../ipc/receipts.js';
import { registerSaleHistoryHandlers } from '../ipc/sale-history.js';
import { registerSalesHandlers } from '../ipc/sales.js';
import type { JwtHolder } from '../operator/jwt-holder.js';
import { resolveSessionScope } from '../operator/resolve-session-scope.js';
import type { SessionManager } from '../operator/session-manager.js';
import { createSendableDeviceTokenRead } from '../pairing/device-token.js';
import type { SendableDeviceTokenReaderDeps } from '../pairing/device-token.js';
import type { PairingStore } from '../pairing/store.js';
import type { PaymentAuditEvent } from '../payments/audit-emitter.js';
import { createPrintDispatcher } from '../receipts/print-dispatcher.js';
import type { PrintPipeline } from '../receipts/print-pipeline.js';
import { createReceiptsBridge } from '../receipts/receipts-bridge.js';
import { createSaleHistoryClient } from '../sale-history/sale-history-client.js';
import { createSaleHistoryCredentialResolver } from '../sale-history/sale-history-credential.js';
import { createSaleHistoryLocalReads } from '../sale-history/sale-history-local.js';
import { createSaleHistoryService } from '../sale-history/sale-history-service.js';
import { createStoreZoneMonitor } from '../sale-history/store-zone-monitor.js';
import { createSaleVoidRepository } from '../sale-void/sale-void-repository.js';
import { createSaleAuditEmitter, type SaleAuditEvent } from '../sales/audit-emitter.js';
import { bindBannerStateProjector } from '../sales/banner-state-projector.js';
import { bindDrawerEventsRepository } from '../sales/repositories/drawer-events.repository.js';
import { bindPrintEventsRepository } from '../sales/repositories/print-events.repository.js';
import { bindSalesRepository } from '../sales/repositories/sales.repository.js';
import { createSalesBridge, type OperatorSessionForSales } from '../sales/sales-bridge.js';
import { resolveApiBaseUrl } from './env.js';

/** What `registerSalesBridges` closes over from the composition root (RT-900 extraction 6a). */
export interface SalesBridgesDeps {
  /** The lock-guarded `ipcMain` the `sales.*`, `receipts.*` and sale-history handlers register on. */
  guardedIpcMain: IpcMain;
  /** The open database handle every repository and read in the bridges is bound to. */
  db: DatabaseHandle;
  /** The reachability-observed Backend-Core fetch the sale-history client is built on. */
  backendFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The operator session: the live session and its lock state, read on every call. */
  operatorSessionManager: Pick<SessionManager, 'getCurrent'>;
  /** The operator envelope holder the sale-history credential resolver reads. */
  operatorEnvelopeHolder: Pick<JwtHolder, 'get'>;
  /** The pairing store: the live terminal id, and the status the device-token reader checks. */
  pairingStore: Pick<PairingStore, 'getCurrentTerminalId'> &
    SendableDeviceTokenReaderDeps['pairingStore'];
  /** The SecretStore the device-token reader unseals the token from. */
  secretStore: SendableDeviceTokenReaderDeps['secretStore'];
  /** The SecretStore key of the sealed device token (`index.ts` owns the constant). */
  deviceTokenKey: SendableDeviceTokenReaderDeps['deviceTokenKey'];
  /** Forwards a sale audit event into the local audit store. */
  forwardAuditEvent: (evt: PaymentAuditEvent | SaleAuditEvent) => void;
  /** The one print pipeline (receipts, return slips and reprints share it). */
  printPipeline: PrintPipeline;
  /** The chosen printer's device name, read on every print; undefined = the Windows default. */
  chosenPrinterName: () => string | undefined;
  /** The shared drawer transport (also used by the RT-15 S4 return payout). */
  drawerKickTransport: DrawerKickTransport;
  mainLogger: Logger;
}

/** What the paired finalize closure in `index.ts` reuses from the bridges. */
export interface SalesBridges {
  salesRepo: ReturnType<typeof bindSalesRepository>;
  saleAuditEmitter: ReturnType<typeof createSaleAuditEmitter>;
  printDispatcher: ReturnType<typeof createPrintDispatcher>;
  drawerKickDispatcher: ReturnType<typeof createDrawerKickDispatcher>;
}

/**
 * Registers the read-only `sales.*` bridge, `receipts.*` bridge and the sale-history handlers.
 * `index.ts` calls it inside the `sale_finalization` flag gate, at the exact position the inline
 * code held: before the paired finalize worker. It returns the handles the finalize closure reuses.
 */
export function registerSalesBridges(deps: SalesBridgesDeps): SalesBridges {
  const {
    guardedIpcMain,
    db,
    backendFetch,
    operatorSessionManager,
    operatorEnvelopeHolder,
    pairingStore,
    secretStore,
    deviceTokenKey,
    forwardAuditEvent,
    printPipeline,
    chosenPrinterName,
    drawerKickTransport,
    mainLogger,
  } = deps;

  const salesRepo = bindSalesRepository(db);
  const printEventsRepo = bindPrintEventsRepository(db);
  const drawerEventsRepo = bindDrawerEventsRepository(db);
  // RT-542: read-only use of the void journal (the OD-534-8 reprint guard).
  const saleVoidReads = createSaleVoidRepository(db);

  // Read-only `sales.*` + `receipts.preview` bridges for the renderer.
  // Registered UNCONDITIONALLY whenever the flag is on — NOT gated on
  // pairing status. Pairing happens in-renderer (PairingForm navigates
  // to /paired without a process relaunch), so a terminal that boots
  // unpaired and pairs later in the same process must still have these
  // handlers; otherwise the renderer's reads reject at the IPC layer. Both
  // bridges gate on the live session at call time, so they are inert until
  // an operator signs in regardless of pairing timing.
  // #380 (F-007 FIXED) — same extracted seam as the payments adapter; the
  // returned payments-shaped scope is a structural superset of
  // OperatorSessionForSales. Real terminal_id from the pairing store; null
  // on no-session or unpaired.
  const getCurrentSalesSession = (): OperatorSessionForSales | null =>
    resolveSessionScope(operatorSessionManager.getCurrent(), pairingStore.getCurrentTerminalId());
  // RT-546 — the sales/receipts role gate refuses a locked session and
  // audits a refusal (`sale.access.refused`). Hoisted so both bridges get it.
  const isSalesSessionLocked = (): boolean =>
    operatorSessionManager.getCurrent()?.lock_state === 'locked';
  const saleAuditEmitter = createSaleAuditEmitter({
    sink: { write: forwardAuditEvent },
  });
  const salesBridge = createSalesBridge({
    getCurrentSession: getCurrentSalesSession,
    isSessionLocked: isSalesSessionLocked,
    auditEmitter: saleAuditEmitter,
    salesRepo,
    printEventsRepo,
    drawerEventsRepo,
    // Snapshot-subscribe projector (008 follow-up): sales.subscribe returns
    // the current banner_state / recent projection; the renderer polls it.
    bannerStateProjector: bindBannerStateProjector(db),
    newSubscriptionToken: () => randomUUID(),
  });
  registerSalesHandlers(guardedIpcMain, { salesBridge });

  // 008 Slice 3 — print dispatcher (used by both the auto-fire finalize
  // seam AND the renderer-callable receipts.retryPrint handler). Built
  // here (not inside the paired branch) so the receipts bridge can be
  // registered UNCONDITIONALLY — the T094c lesson: IPC handlers must be
  // present regardless of pairing, since pairing is in-renderer with no
  // relaunch. The dispatcher needs only the DB + repos + audit sink, none
  // of which are pairing-specific; the paired branch reuses it for the
  // finalize-listener wiring.
  // Shared clock for the print dispatcher + receipts bridge so a reprint's
  // rendered slip time (bridge) matches the print_events.printed_at the
  // dispatcher writes for the same logical event (one clock read per event).
  const receiptsClock = (): string => new Date().toISOString();
  const printDispatcher = createPrintDispatcher({
    pipeline: printPipeline,
    printEventsRepo,
    auditEmitter: saleAuditEmitter,
    now: receiptsClock,
    newPrintEventId: () => randomUUID(),
    logger: mainLogger,
    // RT-886: `printer_source` on `sale.receipt.printed`.
    printerSource: () => (chosenPrinterName() === undefined ? 'os_default' : 'chosen'),
  });

  // 008 Slice 4 — drawer-kick dispatcher (AD-8 separate command). Chains
  // after a successful first print for cash-inclusive sales. The real
  // DK1/DK2 transport (node-thermal-printer `openCashDrawer` ↔ the Epson's
  // DRAWER port driving the APG VBS320) is the §A3 HARDWARE bring-up (T200),
  // deferred — same posture as the print transport above. Until then an
  // honest STUB reports `no_drawer_configured`, which (RT-531) the
  // dispatcher records as a `suppressed` drawer row — no drawer-failure
  // notice — while the Sale stays durable; no fake "opened" is recorded
  // (PRODUCT.md Principle 3). T200 swaps the shared `drawerKickTransport` (hoisted above,
  // also used by the RT-15 S4 return payout) for the real one; nothing else
  // changes.
  const drawerKickDispatcher = createDrawerKickDispatcher({
    drawerEventsRepo,
    transport: drawerKickTransport,
    auditEmitter: saleAuditEmitter,
    now: () => new Date().toISOString(),
    newDrawerEventId: () => randomUUID(),
    logger: mainLogger,
  });

  // 008 Slice 2 + 3 — receipts.preview (read-only render) + retryPrint
  // (mutating; gated server-side). Registered unconditionally (T094c).
  const receiptsBridge = createReceiptsBridge({
    getCurrentSession: getCurrentSalesSession,
    isSessionLocked: isSalesSessionLocked,
    salesRepo,
    printEventsRepo,
    printDispatcher,
    // S4: a retry-success runs drawer gating (FR-052 — retry-success is the
    // canonical first print). Same STUB transport as the auto-fired path
    // until the T200 hardware bring-up.
    drawerKickDispatcher,
    // S5: same clock as printDispatcher so the reprint slip time matches the
    // print_events.printed_at row.
    now: receiptsClock,
    // S6 manualOverride: writes the override print_events row directly +
    // emits sale.receipt.manual_override (no slip rendered → no dispatcher).
    auditEmitter: saleAuditEmitter,
    newPrintEventId: () => randomUUID(),
    // RT-542 (OD-534-8 B): a sale with a live void gets no unmarked duplicate.
    isSaleVoided: (saleId) => saleVoidReads.liveForSale(saleId) !== null,
  });
  registerReceiptsHandlers(guardedIpcMain, { receiptsBridge });

  // RT-542 (RT-534 S6) — the store-wide sales history, sale detail and
  // reprint through Backend-Core (sale-history.yaml). The RT-546 gate and
  // OD-534-1/2 run in main; the credential follows the role (the envelope
  // for a manager/admin, the device token + the session's own cashier
  // admission for a cashier) and never crosses the bridge. Offline, or with
  // no credential, it answers this device's sales only (the RT-541 read).
  registerSaleHistoryHandlers(guardedIpcMain, {
    service: createSaleHistoryService({
      getCurrentSession: getCurrentSalesSession,
      isSessionLocked: isSalesSessionLocked,
      auditEmitter: saleAuditEmitter,
      resolveCredential: createSaleHistoryCredentialResolver({
        getSessionRecord: () => operatorSessionManager.getCurrent(),
        getEnvelope: (backendSessionId) => operatorEnvelopeHolder.get(backendSessionId),
        readDeviceToken: createSendableDeviceTokenRead({
          pairingStore,
          secretStore,
          deviceTokenKey,
        }),
      }),
      client: createSaleHistoryClient({
        baseUrl: resolveApiBaseUrl(),
        fetch: backendFetch,
      }),
      local: createSaleHistoryLocalReads(db),
      salesRepo,
      printEventsRepo,
      // OD-534-8 B: a live local void forbids a duplicate and marks the record.
      isSaleVoided: (saleId) => saleVoidReads.liveForSale(saleId) !== null,
      printer: printPipeline,
      now: receiptsClock,
      newIdempotencyKey: () => `pos-pulse-reprint:${randomUUID()}`,
      // RT-553: warns (once) and flags when the store zone is not Africa/Cairo.
      storeZone: createStoreZoneMonitor({ logger: mainLogger }),
    }),
    logger: mainLogger,
  });

  return { salesRepo, saleAuditEmitter, printDispatcher, drawerKickDispatcher };
}
