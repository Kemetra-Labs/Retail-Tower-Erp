import type { IpcMain } from 'electron';
import type { Logger } from 'pino';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import { resolveFeatureFlags } from '../app/feature-flags.js';
import type { DatabaseHandle } from '../db/client.js';
import { terminalDrawerSlot } from '../drawer/drawer-slot.js';
import { registerSaleVoidHandlers } from '../ipc/sale-void.js';
import type { JwtHolder } from '../operator/jwt-holder.js';
import { createSaleSyncTokenReader } from '../operator/sale-sync-token.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { PairingStore } from '../pairing/store.js';
import type { PaymentAuditEvent } from '../payments/audit-emitter.js';
import {
  composeSaleVoid,
  SALE_VOID_DRAIN_TIMEOUT_MS,
  scheduleSaleVoidSync,
  type ComposedSaleVoid,
  type ComposeSaleVoidDeps,
} from '../sale-void/compose-sale-void.js';
import { createSaleAuditEmitter, type SaleAuditEvent } from '../sales/audit-emitter.js';
import { resolveApiBaseUrl } from './env.js';
import { processLateReturnCheck } from './returns.js';

/** What `registerSaleVoid` closes over from the composition root (RT-893 extraction 5). */
export interface SaleVoidDeps {
  /** The lock-guarded `ipcMain` the `saleVoid:*` handlers are registered on. */
  guardedIpcMain: IpcMain;
  /** The open database handle the void journal and the send engine use. */
  db: DatabaseHandle;
  /** The reachability-observed Backend-Core fetch the void client is built on. */
  backendFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The operator session: the live session, its lock state and the requester's envelope key. */
  operatorSessionManager: Pick<SessionManager, 'getCurrent'>;
  /** The operator envelope holder the sale-sync token reader reads. */
  operatorEnvelopeHolder: Pick<JwtHolder, 'get'>;
  /** The pairing store: the live paired terminal id (null while unpaired or revoked). */
  pairingStore: Pick<PairingStore, 'getCurrentTerminalId'>;
  /**
   * RT-1403: the sendable device-token read (null unless paired, null once revoked; never
   * rejects) for a cashier's void. Read in process per send, never bridged.
   */
  getDeviceToken: () => Promise<string | null>;
  /** RT-1403 S2: the sale drawer's hardware port (the same instance sales and returns use). */
  drawerKickTransport: ComposeSaleVoidDeps['drawer'];
  /** The one manager approval service (a void spends a single-use RT-114 approval). */
  managerApprovals: ComposeSaleVoidDeps['approvals'];
  /** The audit sink the void journal writes to. */
  auditEmitter: ComposeSaleVoidDeps['auditSink'];
  /** Forwards a sale audit event into the local audit store (RT-741 `sale.access.refused`). */
  forwardAuditEvent: (evt: PaymentAuditEvent | SaleAuditEvent) => void;
  /** Owns the stop callback for the void send interval, run before the DB handle closes. */
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  mainLogger: Logger;
  /**
   * RT-530: the sale void's approval subject, bound here once the domain exists. `index.ts` owns
   * it (the manager approval service is built before this call and reads it).
   */
  saleVoidRef: { current: ComposedSaleVoid | null };
}

/**
 * Registers the `saleVoid:*` IPC handlers and, with `POS_PULSE_FEATURE_SALE_VOID` on, the
 * background void send. It is called at the exact boot position the inline code held in
 * `main/index.ts`: after the sale-sync worker wiring and before `registerReturns`.
 */
export function registerSaleVoid(deps: SaleVoidDeps): void {
  const {
    guardedIpcMain,
    db,
    backendFetch,
    operatorSessionManager,
    operatorEnvelopeHolder,
    pairingStore,
    getDeviceToken,
    drawerKickTransport,
    managerApprovals,
    auditEmitter,
    forwardAuditEvent,
    workerRegistry,
    mainLogger,
    saleVoidRef,
  } = deps;

  // ── RT-530 — manager-approved void of a finalized sale ──
  //
  // The `saleVoid:*` handlers are registered UNCONDITIONALLY (the renderer
  // gets a typed `feature_disabled` refusal, never "no handler"); the service
  // re-reads `POS_PULSE_FEATURE_SALE_VOID` per call (default off). A request
  // spends a single-use RT-114 manager approval and journals the void; the
  // send engine posts it later as the REQUESTER only, once the sale has
  // synced: a manager or admin under their own operator envelope (the same
  // in-process envelope reader sale sync uses), a cashier (RT-1403) with the
  // device bearer (the sendable read, in process per send) plus their own
  // `operatorUserId`.
  const saleVoidDomain = composeSaleVoid({
    db,
    http: {
      baseUrl: resolveApiBaseUrl(),
      fetch: backendFetch,
    },
    getOperatorEnvelope: createSaleSyncTokenReader(operatorSessionManager, operatorEnvelopeHolder),
    getDeviceToken,
    getSession: () => operatorSessionManager.getCurrent(),
    getTerminalId: () => pairingStore.getCurrentTerminalId(),
    isSessionLocked: () => operatorSessionManager.getCurrent()?.lock_state === 'locked',
    isEnabled: () => resolveFeatureFlags().saleVoid,
    approvals: managerApprovals,
    // RT-1403 S2: the void payout kicks the SAME drawer port as sales and returns.
    drawer: drawerKickTransport,
    drawerSlot: terminalDrawerSlot,
    auditSink: auditEmitter,
    // RT-741: `saleVoid.lookup` runs the shared RT-546 gate; its refusals are
    // `sale.access.refused`, written like the sales and receipts bridges' own.
    accessAudit: createSaleAuditEmitter({ sink: { write: forwardAuditEvent } }),
    logger: mainLogger,
    now: () => new Date().toISOString(),
    // RT-1553: a late commit of a closed return makes it live again before a void is quoted.
    checkLateReturns: (saleId) => processLateReturnCheck.current?.(saleId) ?? Promise.resolve(),
  });
  saleVoidRef.current = saleVoidDomain;
  registerSaleVoidHandlers(guardedIpcMain, {
    service: saleVoidDomain.service,
    logger: mainLogger,
  });
  if (resolveFeatureFlags().saleVoid) {
    // Each pass resolves its sender live (the signed-in operator and their
    // envelope), so a requester who signs in later is picked up without a restart.
    const SALE_VOID_SEND_INTERVAL_MS = 5_000;
    const stopSaleVoidSync = scheduleSaleVoidSync({
      sync: saleVoidDomain.sync,
      stopDomain: saleVoidDomain.stop,
      intervalMs: SALE_VOID_SEND_INTERVAL_MS,
      drainTimeoutMs: SALE_VOID_DRAIN_TIMEOUT_MS,
      logger: mainLogger,
    });
    workerRegistry.register('sale-void interval', () => {
      void stopSaleVoidSync();
    });
  }
}
