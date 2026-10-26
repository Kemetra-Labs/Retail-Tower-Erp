import type { IpcMain } from 'electron';
import type { Logger } from 'pino';
import type { PairedWorkers } from '../app/paired-workers.js';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import { parseFeatureFlags } from '../app/feature-flags.js';
import type { DatabaseHandle } from '../db/client.js';
import { registerShiftCashupIpc } from '../ipc/shift-cashup.js';
import type { JwtHolder } from '../operator/jwt-holder.js';
import { createManagerEnvelopeReader } from '../operator/manager-envelope-token.js';
import { managerIdentityOf } from '../operator/manager-pin-enrollment.js';
import type { ManagerPinStore } from '../operator/manager-pin-store.js';
import { resolveSessionScope } from '../operator/resolve-session-scope.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { DeviceAuthDetector } from '../pairing/device-auth-detector.js';
import type { DeviceRevocationStore, PairingStore } from '../pairing/store.js';
import { createCurrentTerminalResolver } from '../sales-sync/current-terminal.js';
import type { SafeStorageLike } from '../secrets/safe-storage.js';
import {
  pairedShiftScope,
  registerShiftSync,
  startShiftSync,
} from '../shift-cashup/compose-shift-cashup.js';
import type { UpdateService } from '../update/update-service.js';
import { resolveApiBaseUrl } from './env.js';

/** What `registerShift` closes over from the composition root (RT-893 extraction 4). */
export interface ShiftDeps {
  /** The lock-guarded `ipcMain` the shift cash-up handlers are registered on. */
  guardedIpcMain: IpcMain;
  /** The open database handle the shift sync engine and the cash-up service use. */
  db: DatabaseHandle;
  /** The pairing store: the live terminal, the paired scope and the RT-215 pairing epoch. */
  pairingStore: Pick<PairingStore, 'getStatus' | 'getCurrentTerminalId'> &
    Pick<DeviceRevocationStore, 'getPairingEpoch'>;
  /** The once-latch for paired-only workers: holds the shift sync engine's starter. */
  pairedWorkersLatch: PairedWorkers;
  /** Owns the stop callback for the shift sync interval, run before the DB handle closes. */
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  /** The operator session holder: the live session, its lock state and its start hook. */
  operatorSessionManager: Pick<SessionManager, 'getCurrent' | 'onStarted'>;
  /** The operator envelope holder the manager envelope reader reads (forced-close sends). */
  operatorEnvelopeHolder: Pick<JwtHolder, 'get'>;
  mainLogger: Logger;
  /** The reachability-observed Backend-Core fetch the shift sync client is built on. */
  backendFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** RT-215: counts a shift sync 401 toward a confirmed device revocation. */
  deviceAuthDetector: Pick<DeviceAuthDetector, 'observe'>;
  /** The one reader of the device token for sending (null unless paired and not revoked). */
  readSendableDeviceToken: () => Promise<string | null>;
  /** Seals the manager PIN hashes at rest (DPAPI on Windows). */
  safeStorage: SafeStorageLike;
  /** RT-443: the one manager PIN store, shared with the approval service. */
  managerPins: ManagerPinStore;
  /** RT-772: the cashier's shift close reports to it (`notifyShiftClosed`). */
  updateService: Pick<UpdateService, 'notifyShiftClosed'>;
  /**
   * RT-554 (b): the "drain the shift outbox now" holder. `index.ts` owns it (the manager's
   * forced-close handler reads it); the shift sync engine assigns it once it starts.
   */
  shiftSyncDrainNowRef: { current: (() => Promise<boolean>) | null };
}

/**
 * Registers the shift cash-up sync engine and the shift cash-up IPC, each behind its own read of
 * the `POS_PULSE_FEATURE_SHIFT_CASHUP` flag (default off: with it off nothing is registered, the
 * engine never starts and no shift channel exists). It is called at the exact boot position the
 * inline code held in `main/index.ts`: after the returns wiring and before `startUpdater`. The
 * two registrations stay adjacent and in their original order, so there is no register/start split.
 */
export function registerShift(deps: ShiftDeps): void {
  const {
    guardedIpcMain,
    db,
    pairingStore,
    pairedWorkersLatch,
    workerRegistry,
    operatorSessionManager,
    operatorEnvelopeHolder,
    mainLogger,
    backendFetch,
    deviceAuthDetector,
    readSendableDeviceToken,
    safeStorage,
    managerPins,
    updateService,
    shiftSyncDrainNowRef,
  } = deps;

  // ── RT-17 slice 3 — shift cash-up sync (flag-gated, default off) ──
  //
  // With POS_PULSE_FEATURE_SHIFT_CASHUP off (default, owner approval 10920)
  // nothing is registered: the shift sync engine never starts. With it on,
  // the engine is a paired-only worker like sale sync: the same device token
  // reader (null unless paired, null once revoked), the same live current-
  // terminal resolver (RT-221) and the RT-215 detector on every answer, one
  // tick every 5 s, stopped with the other workers before the DB closes.
  registerShiftSync({
    enabled: parseFeatureFlags(process.env).shiftCashup,
    pairedWorkers: pairedWorkersLatch,
    workers: workerRegistry,
    start: (terminal) =>
      startShiftSync({
        db,
        terminal,
        client: {
          baseUrl: resolveApiBaseUrl(),
          fetch: backendFetch,
          detector: deviceAuthDetector,
          getDeviceToken: readSendableDeviceToken,
          currentTerminalId: () => pairingStore.getCurrentTerminalId(),
          // RT-554 (b): a forced close goes out under a manager / admin's envelope only.
          getEnvelope: createManagerEnvelopeReader(operatorSessionManager, operatorEnvelopeHolder),
        },
        resolveTerminalId: createCurrentTerminalResolver(() => pairingStore.getStatus()),
        logger: mainLogger,
        onDrainNow: (drainNow) => {
          shiftSyncDrainNowRef.current = drainNow;
        },
      }),
  });

  // ── RT-17 slice 4 part 1 — shift cash-up IPC (flag-gated, default off) ──
  //
  // Registered only with POS_PULSE_FEATURE_SHIFT_CASHUP on, on the
  // lock-guarded ipcMain (no shift channel is on the lock allowlist). The
  // service re-reads the flag and requires the live operator session on the
  // paired terminal on every call; a fact needs an admitted cashier.
  // Part 2 (RT-17 10943): a variance close takes a manager PIN, verified
  // against the local manager PIN records (sealed with safeStorage); a
  // manager signed in online enrols theirs. Re-checks after an await read
  // the RT-215 pairing epoch (F2, 10944).
  registerShiftCashupIpc({
    enabled: parseFeatureFlags(process.env).shiftCashup,
    ipcMain: guardedIpcMain,
    db,
    isEnabled: () => parseFeatureFlags(process.env).shiftCashup,
    getSession: () =>
      resolveSessionScope(operatorSessionManager.getCurrent(), pairingStore.getCurrentTerminalId()),
    isSessionLocked: () => operatorSessionManager.getCurrent()?.lock_state === 'locked',
    pairedScope: async () => pairedShiftScope(await pairingStore.getStatus()),
    pairingEpoch: () => pairingStore.getPairingEpoch(),
    getManager: () => managerIdentityOf(operatorSessionManager.getCurrent()),
    onSessionStarted: (listener) => {
      operatorSessionManager.onStarted(listener);
    },
    currentTerminalId: () => pairingStore.getCurrentTerminalId(),
    safeStorage,
    now: () => new Date().toISOString(),
    logger: mainLogger,
    // RT-443: the one store, shared with the approval service (audited there).
    managerPins,
    // RT-772: the cashier's shift close is a safe-point trigger for an update install.
    onShiftClosed: () => {
      updateService.notifyShiftClosed();
    },
  });
}
