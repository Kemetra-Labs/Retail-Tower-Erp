import type { IpcMain } from 'electron';
import type { Logger } from 'pino';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import { parseFeatureFlags } from '../app/feature-flags.js';
import type { DatabaseHandle } from '../db/client.js';
import { registerReturnsHandlers } from '../ipc/returns.js';
import type { JwtHolder } from '../operator/jwt-holder.js';
import { resolveSessionScope } from '../operator/resolve-session-scope.js';
import { createSaleSyncTokenReader } from '../operator/sale-sync-token.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { PairingStore } from '../pairing/store.js';
import {
  composeReturns,
  RETURNS_DRAIN_TIMEOUT_MS,
  scheduleReturnsResolver,
  type ComposeReturnsDeps,
} from '../returns/compose-returns.js';
import { resolveApiBaseUrl } from './env.js';

/** What `registerReturns` closes over from the composition root (RT-893 extraction 5). */
export interface ReturnsDeps {
  /** The lock-guarded `ipcMain` the `returns:*` handlers are registered on. */
  guardedIpcMain: IpcMain;
  /** The open database handle the return journal, payouts and the resolver use. */
  db: DatabaseHandle;
  /** The reachability-observed Backend-Core fetch the returns client is built on. */
  backendFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The operator session: the live session, its lock state and the envelope key. */
  operatorSessionManager: Pick<SessionManager, 'getCurrent'>;
  /** The operator envelope holder the returns authorizer reads (snapshot and recheck only). */
  operatorEnvelopeHolder: Pick<JwtHolder, 'get'>;
  /** The pairing store: the live paired terminal id (null while unpaired or revoked). */
  pairingStore: Pick<PairingStore, 'getCurrentTerminalId'>;
  /** The audit sink the return journal writes to. */
  auditEmitter: ComposeReturnsDeps['auditSink'];
  /** RT-15 S4: the sale drawer's hardware port (the same instance sales use). */
  drawerKickTransport: ComposeReturnsDeps['drawer'];
  /** RT-15 S4: the receipt print pipeline (the same instance sales use). */
  printPipeline: ComposeReturnsDeps['printer'];
  /** Owns the stop callback for the returns resolver interval, run before the DB handle closes. */
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  mainLogger: Logger;
}

/**
 * Registers the `returns:*` IPC handlers and, with `POS_PULSE_FEATURE_RETURNS` on, the background
 * returns resolver. It is called at the exact boot position the inline code held in
 * `main/index.ts`: right after `registerSaleVoid` and before `registerShift`.
 */
export function registerReturns(deps: ReturnsDeps): void {
  const {
    guardedIpcMain,
    db,
    backendFetch,
    operatorSessionManager,
    operatorEnvelopeHolder,
    pairingStore,
    auditEmitter,
    drawerKickTransport,
    printPipeline,
    workerRegistry,
    mainLogger,
  } = deps;

  // ── RT-15 S2 — cashier returns (main-process domain; no renderer UI yet) ──
  //
  // The `returns:*` handlers are registered UNCONDITIONALLY (T094c lesson: the
  // renderer gets a typed `feature_disabled` refusal, never "no handler"). The
  // service re-reads `POS_PULSE_FEATURE_RETURNS` per call (default off, AC1),
  // requires a manager/admin operator session (D-b), and talks only to
  // Backend-Core `/api/pos/v1/sales/...` (AC7) with the operator envelope of
  // the admitted authorization snapshot (RT-197 A5). The background resolver
  // (startup + interval) re-sends `pending` / `unknown` returns with the
  // identical request; it is scheduled with the flag on and resolves pairing +
  // operator live on every tick.
  const returnsDomain = composeReturns({
    db,
    http: {
      baseUrl: resolveApiBaseUrl(),
      fetch: backendFetch,
    },
    // RT-197 A5: read only into the authorization snapshot (and at a
    // recheck); every send carries the snapshot's envelope explicitly.
    getOperatorEnvelope: createSaleSyncTokenReader(operatorSessionManager, operatorEnvelopeHolder),
    isEnabled: () => parseFeatureFlags(process.env).returns,
    getSession: () =>
      resolveSessionScope(operatorSessionManager.getCurrent(), pairingStore.getCurrentTerminalId()),
    isSessionLocked: () => operatorSessionManager.getCurrent()?.lock_state === 'locked',
    auditSink: auditEmitter,
    logger: mainLogger,
    now: () => new Date().toISOString(),
    // RT-15 S4: the SAME drawer port and print pipeline as sales (no new
    // hardware path): the payout kicks the drawer, the slip prints through
    // the receipt pipeline's path selection.
    drawer: drawerKickTransport,
    printer: printPipeline,
  });
  registerReturnsHandlers(guardedIpcMain, { service: returnsDomain.service });
  if (parseFeatureFlags(process.env).returns) {
    // Scheduled regardless of pairing: each tick resolves the paired terminal
    // and an eligible (unlocked manager/admin) operator live, so in-process
    // pairing needs no restart; until then every tick is a no-op.
    const RETURNS_RESOLVER_INTERVAL_MS = 30_000;
    const stopReturnsResolver = scheduleReturnsResolver({
      resolver: returnsDomain.resolver,
      stopDomain: returnsDomain.stop,
      intervalMs: RETURNS_RESOLVER_INTERVAL_MS,
      drainTimeoutMs: RETURNS_DRAIN_TIMEOUT_MS,
      logger: mainLogger,
    });
    // Synchronous like every worker stop: latches the domain stopped (no
    // send starts; an in-flight send writes nothing when it settles), so the
    // DB may close right after. The drain promise is not awaited here.
    workerRegistry.register('returns resolver', () => {
      void stopReturnsResolver();
    });
  }
}
