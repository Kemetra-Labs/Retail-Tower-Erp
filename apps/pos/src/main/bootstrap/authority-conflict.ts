import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import type { AuditEvent, OperatorRefusal } from '../../shared/audit/event-shape.js';
import { registerResolveConflictHandler } from '../ipc/session-lock.js';
import { AuthorityConflictResolver } from '../operator/authority-conflict-resolver.js';
import type { CashierAdmissionKeeper } from '../operator/cashier-admission-keeper.js';
import type { CashierAdmissionDeps } from '../operator/cashier-admission.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { PairingStore } from '../pairing/store.js';

/** What `registerAuthorityConflictResolution` closes over from the composition root. */
interface AuthorityConflictBootstrapDeps {
  /** The lock-guarded `ipcMain`: the channel is on the locked-session allowlist. */
  ipcMain: IpcMain;
  sessionManager: SessionManager;
  /** The 004 cashier PIN check (and its lockout), shared with sign-in and unlock. */
  verifyCashierPin: (operator_id: string, pin: string) => Promise<OperatorRefusal | null>;
  admission: CashierAdmissionDeps;
  keeper: Pick<CashierAdmissionKeeper, 'onConflictTakenOver'>;
  auditEmitter: { emit(event: AuditEvent): void };
  pairingStore: Pick<PairingStore, 'getCurrentTerminalId'>;
  mainLogger: Logger;
}

/**
 * RT-309 D9 (RT-113 10763 D9) — `operator.resolveConflict`: the cashier's
 * decision on an authority-conflict lock (take over here / end here), after a
 * PIN check. A taken-over session's heartbeat is armed by the keeper.
 */
export function registerAuthorityConflictResolution(deps: AuthorityConflictBootstrapDeps): void {
  const resolver = new AuthorityConflictResolver({
    sessionManager: deps.sessionManager,
    verifyCashierPin: deps.verifyCashierPin,
    admission: deps.admission,
    onTakenOver: (session_id) => {
      deps.keeper.onConflictTakenOver(session_id);
    },
    audit: deps.auditEmitter,
    resolveTerminalId: () => deps.pairingStore.getCurrentTerminalId(),
    tillClockMs: Date.now, // RT-1312 F18: the same till clock check as a cashier takeover
    logger: deps.mainLogger,
  });
  registerResolveConflictHandler(deps.ipcMain, { resolver });
}
