import type { IpcMain } from 'electron';
import type { Logger } from 'pino';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import { resolveFeatureFlags } from '../app/feature-flags.js';
import type { DatabaseHandle } from '../db/client.js';
import { terminalDrawerSlot } from '../drawer/drawer-slot.js';
import { registerReturnsHandlers } from '../ipc/returns.js';
import type {
  ApprovalSubjectResolver,
  ManagerApprovalService,
} from '../operator/manager-approval-service.js';
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
import { createReturnDispositionsRepository } from '../returns/returns-dispositions-repository.js';
import { createReturnsRepository } from '../returns/returns-repository.js';
import {
  RETURN_RESOLVE_ACTION_KIND,
  createReturnResolveApprovalResolver,
} from '../returns/returns-resolve-approval.js';
import {
  createStatusReadAvailability,
  type StatusReadAvailability,
} from '../returns/returns-status-availability.js';
import { operatorUserIdOf } from '../sale-void/sale-void-session.js';
import { createShiftCashupRepo } from '../shift-cashup/shift-cashup-repo.js';
import { openShiftRefOf, shiftRefAtOf } from '../returns/returns-execution-enqueue.js';
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
  /**
   * RT-1498 S4/S5: the one manager approval service. `returns:escalate` spends a single-use
   * `return.resolve_unknown` approval through it, inside the transaction that writes the disposition.
   */
  managerApprovals: Pick<ManagerApprovalService, 'consume' | 'evidence'>;
  /**
   * RT-1498 close slice: whether the server's status read is available. Absent: the process-wide one
   * the approval's subject resolver (`returnResolveApprovalResolvers`) also reads by default, so a
   * close is offered only while the last status probe was answered with a verdict (never a 404).
   */
  statusAvailability?: StatusReadAvailability;
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
 * RT-1498 close slice: the one status-read availability of this process. The approval service is built
 * before `registerReturns` runs (in `index.ts`), so the approval's subject resolver and the composed
 * return domain meet here: the domain notes every status read in it, and a close approval is named only
 * while it says the server's status read is available (fail closed: unknown is unavailable).
 */
export const processStatusAvailability: StatusReadAvailability = createStatusReadAvailability();

/**
 * RT-1498 S4/S5: the manager-approval subject resolver of `return.resolve_unknown` (the approval of
 * handing an unknown return to support, or of closing it, with the disposition bound into its subject).
 * Built over the same database and the live paired terminal; `index.ts` spreads it into the approval
 * service's resolvers because that service is built before `registerReturns` runs. A close subject is
 * named only while the server's status read is available (RT-1498 close slice).
 */
export function returnResolveApprovalResolvers(
  db: DatabaseHandle,
  pairingStore: Pick<PairingStore, 'getCurrentTerminalId'>,
  statusAvailability: StatusReadAvailability = processStatusAvailability,
): Record<typeof RETURN_RESOLVE_ACTION_KIND, ApprovalSubjectResolver> {
  return {
    [RETURN_RESOLVE_ACTION_KIND]: createReturnResolveApprovalResolver({
      repo: createReturnsRepository(db),
      dispositions: createReturnDispositionsRepository(db),
      terminalId: () => pairingStore.getCurrentTerminalId(),
      closeAvailable: () => statusAvailability.isAvailable(),
    }),
  };
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
    managerApprovals,
    statusAvailability = processStatusAvailability,
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
  // service re-reads `POS_PULSE_FEATURE_RETURNS` per call (default on since RT-1180),
  // requires a manager/admin operator session (D-b), and talks only to
  // Backend-Core `/api/pos/v1/sales/...` (AC7) with the operator envelope of
  // the admitted authorization snapshot (RT-197 A5). The background resolver
  // (startup + interval) re-sends `pending` / `unknown` returns with the
  // identical request; it is scheduled with the flag on and resolves pairing +
  // operator live on every tick.
  const shiftRecords = createShiftCashupRepo(db);
  const returnsDomain = composeReturns({
    db,
    http: {
      baseUrl: resolveApiBaseUrl(),
      fetch: backendFetch,
    },
    // RT-197 A5: read only into the authorization snapshot (and at a
    // recheck); every send carries the snapshot's envelope explicitly.
    getOperatorEnvelope: createSaleSyncTokenReader(operatorSessionManager, operatorEnvelopeHolder),
    isEnabled: () => resolveFeatureFlags().returns,
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
    // RT-1403 S2 (M1): the void payout holds the same drawer: one at a time.
    drawerSlot: terminalDrawerSlot,
    printer: printPipeline,
    // RT-1543: the shift whose drawer paid, for the refund execution's evidence. None open now and
    // none at the claim (shift cash-up was off, so none could be): no execution is reported.
    openShiftRef: openShiftRefOf(shiftRecords),
    // RT-1543 follow-up: a payout claimed while a shift was open and completed after a manager
    // closed it (a claim blocks opening a shift) reports its execution with that claim-time shift.
    shiftRefAt: shiftRefAtOf(shiftRecords),
    // RT-1543: the same signal the shift-cashup bootstrap uses, read per call. Without it no till
    // has a shift, so a new return carries no allocationRef and reports no execution.
    isShiftCashupEnabled: () => resolveFeatureFlags().shiftCashup,
    // RT-1498 close slice: the status-read availability the close approval's resolver also reads.
    statusAvailability,
    // RT-1498 S4/S5: the approval `returns:escalate` and `returns:close` spend, and the requester's `users.id`.
    escalation: {
      approvals: managerApprovals,
      userId: () => {
        const session = operatorSessionManager.getCurrent();
        return session === null ? null : operatorUserIdOf(session);
      },
    },
  });
  registerReturnsHandlers(guardedIpcMain, { service: returnsDomain.service });
  if (resolveFeatureFlags().returns) {
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
