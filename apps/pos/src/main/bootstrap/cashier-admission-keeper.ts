import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import type { AuditEvent, OperatorRefusal } from '../../shared/audit/event-shape.js';
import type { DatabaseHandle } from '../db/client.js';
import { CashierAdmissionKeeper } from '../operator/cashier-admission-keeper.js';
import type { CashierAdmissionDeps } from '../operator/cashier-admission.js';
import { createSafePointProbe } from '../operator/lock-state-reader.js';
import { createOfflineReconcileAudit } from '../operator/offline-reconcile-audit.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { PairingStore } from '../pairing/store.js';
import { registerAuthorityConflictResolution } from './authority-conflict.js';

/** What `registerCashierAdmissionKeeper` closes over from the composition root. */
export interface CashierAdmissionKeeperBootstrapDeps {
  /** RT-309 D9 — the lock-guarded `ipcMain` for `operator:resolve-conflict`. */
  ipcMain: IpcMain;
  /** RT-309 D9 — the 004 cashier PIN check, shared with sign-in and unlock. */
  verifyCashierPin: (operator_id: string, pin: string) => Promise<OperatorRefusal | null>;
  db: DatabaseHandle;
  sessionManager: SessionManager;
  pairingStore: Pick<PairingStore, 'getCurrentTerminalId'>;
  admission: CashierAdmissionDeps;
  auditEmitter: { emit(event: AuditEvent): void };
  /** Late-bound: every sale IPC call re-checks the latched session's safe point through it. */
  saleBoundaryProbe: { recheck: () => void };
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  /** RT-215: its pending confirmation stops with the keeper. */
  deviceAuthDetector: { stop(): void };
  mainLogger: Logger;
}

/**
 * RT-113 P2 — keep the online cashier admission live (heartbeat at ≤ TTL/2,
 * fresh key) and end it on sign-out / session end (best-effort). Lost authority
 * (taken over elsewhere, 403, a confirmed device revocation) latches the
 * session and ends it at its first safe point: no open sale with lines and no
 * live tender on ANY cart of the session (`createSafePointProbe`), re-checked
 * after every sale IPC call, on lock changes and by a backstop poll. Stopped on
 * quit with the other workers (RT-198 latch). RT-1312 F17: the offline
 * reconcile runs inside it; RT-309 (D8): its decisions are audited, durably and
 * before any upgrade (`offline-reconcile-audit.ts`).
 *
 * Returns the keeper: the device-revocation flow latches through it and the
 * sale drain asks it whether a cashier's sales wait for the reconcile.
 */
export function registerCashierAdmissionKeeper(
  deps: CashierAdmissionKeeperBootstrapDeps,
): CashierAdmissionKeeper {
  const resolveTerminalId = (): string | null => deps.pairingStore.getCurrentTerminalId();
  const keeper = new CashierAdmissionKeeper({
    sessionManager: deps.sessionManager,
    admission: deps.admission,
    isAtSafePoint: createSafePointProbe({
      db: deps.db,
      sessionManager: deps.sessionManager,
      resolveTerminalId,
    }),
    offlineReconcileAudit: createOfflineReconcileAudit({
      audit: deps.auditEmitter,
      resolveTerminalId,
      logger: deps.mainLogger,
    }),
    logger: deps.mainLogger,
  });
  deps.saleBoundaryProbe.recheck = () => {
    keeper.recheckSafePoint();
  };
  // RT-309 D9 (10763 D9): a reconcile conflict locks the session; the cashier
  // resolves it here (take over here / end here) after a PIN check.
  registerAuthorityConflictResolution({
    ipcMain: deps.ipcMain,
    sessionManager: deps.sessionManager,
    verifyCashierPin: deps.verifyCashierPin,
    admission: deps.admission,
    keeper,
    auditEmitter: deps.auditEmitter,
    pairingStore: deps.pairingStore,
    mainLogger: deps.mainLogger,
  });
  deps.workerRegistry.register('cashier admission heartbeat', () => {
    keeper.stop();
    deps.deviceAuthDetector.stop();
  });
  return keeper;
}
