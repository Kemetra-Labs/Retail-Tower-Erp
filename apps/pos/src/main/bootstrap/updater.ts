import type { IpcMain } from 'electron';
import path from 'node:path';
// RT-772 — packaged-only, fail-closed updater (ADR-0006). electron-updater is CJS: default
// import, and its singleton is only touched once every guard in UpdateService holds.
import electronUpdater from 'electron-updater';
import type { DatabaseHandle } from '../db/client.js';
import { registerUpdateStatusHandlers, wireUpdateStatusPush } from '../ipc/update-status.js';
import type { SessionManager } from '../operator/session-manager.js';
import { UPDATE_STATUS_IPC_CHANNELS } from '../../shared/update-status/types.js';
import { createPowerShellProbe } from '../update/powershell-signature-probe.js';
import { createPrintActivity } from '../update/print-activity.js';
import type { PrintActivity } from '../update/print-activity.js';
import { createSafePointGate } from '../update/safe-point-gate.js';
import { createSafePointInputs } from '../update/safe-point-inputs.js';
import { createFailClosedVerifier } from '../update/signature-verifier.js';
import { readPublisherPins, resolveUpdateConfig } from '../update/update-config.js';
import { createUpdateService } from '../update/update-service.js';
import type { UpdateLogger, UpdateService } from '../update/update-service.js';
import { broadcastToWindows } from './window.js';

/** RT-772 — room for a shift close's answer to reach the renderer before an update install quits. */
const SHIFT_CLOSE_REPLY_MARGIN_MS = 4_000;

/** What `registerUpdater` closes over from the composition root (RT-893 extraction 2). */
export interface UpdaterDeps {
  /** The guarded `ipcMain` the `updateStatus:get` handler is registered on. */
  guardedIpcMain: IpcMain;
  /** The open database handle the safe-point inputs read from. */
  db: DatabaseHandle;
  /** `isShippedApp(...)`: the trusted "this is the packaged app" predicate (RT-165). */
  shippedApp: boolean;
  /** The operator session holder: no current session means the app is still before sign-in. */
  operatorSessionManager: Pick<SessionManager, 'getCurrent'>;
  mainLogger: UpdateLogger;
}

/** What the rest of the boot sequence needs from the updater wiring. */
export interface UpdaterWiring {
  /** The shift close paths report to it (`notifyShiftClosed`) and `startUpdater` starts it. */
  updateService: UpdateService;
  /** The print pipeline counts every print here, so an update never installs mid-print. */
  printActivity: PrintActivity;
}

/**
 * Builds the POS updater and registers its read-only status bridge. It is called at the exact
 * boot position the inline code held in `main/index.ts`: before the shift close paths and the print
 * dispatcher that report to it. Nothing starts here; `startUpdater` does that after the last IPC
 * registration.
 */
export function registerUpdater(deps: UpdaterDeps): UpdaterWiring {
  const { guardedIpcMain, db, shippedApp, operatorSessionManager, mainLogger } = deps;

  // RT-772 slice 2 — the POS updater (ADR-0006; design §4-§6). Constructed here,
  // before the shift close paths and the print dispatcher that report to it, and
  // started after the last IPC registration. It does nothing unless this is the
  // shipped app AND an origin is configured AND a publisher is pinned (fail
  // closed). It installs only at a safe point: no open shift, nothing in flight.
  const printActivity = createPrintActivity();
  const updateConfig = resolveUpdateConfig(process.env);
  const updateService = createUpdateService({
    isShippedApp: shippedApp,
    origin: updateConfig.origin,
    channel: updateConfig.channel,
    readPublisherPins: () => readPublisherPins(path.join(process.resourcesPath, 'app-update.yml')),
    getUpdater: () => electronUpdater.autoUpdater,
    gate: createSafePointGate(createSafePointInputs(db, printActivity)),
    isBeforeSignIn: () => operatorSessionManager.getCurrent() === null,
    logger: mainLogger,
    // electron-updater's own Windows verifier resolves "valid" when its PowerShell check cannot
    // run; this one returns null only on positive proof (see signature-verifier.ts).
    verifier: createFailClosedVerifier(createPowerShellProbe()),
    // Both close paths notify only once their own work is done (the forced close after its
    // delivery, see ForcedCloseHandler); this is just room for the answer to reach the renderer.
    afterShiftCloseDelayMs: SHIFT_CLOSE_REPLY_MARGIN_MS,
  });
  // RT-322 (S-B) — the read-only update status bridge: `updateStatus:get` plus the
  // `updateStatus:changed` push to the app windows. Sanitized in main; no install
  // trigger and no channel or origin setter cross it.
  registerUpdateStatusHandlers(guardedIpcMain, { read: () => updateService.getStatus() });
  // The listener lives as long as the service; there is nothing to stop at quit.
  wireUpdateStatusPush({
    subscribe: (listener) => updateService.onStatusChange(listener),
    send: (snapshot) => {
      broadcastToWindows(UPDATE_STATUS_IPC_CHANNELS.CHANGED, snapshot);
    },
  });

  return { updateService, printActivity };
}

/** What `startUpdater` needs: the service `registerUpdater` returned. */
export interface StartUpdaterDeps {
  updateService: Pick<UpdateService, 'start'>;
}

/**
 * Starts the updater's scheduled check. `main/index.ts` calls it at the same position as before:
 * after the last IPC registration, so a download that completes at once already sees the real
 * shift, cart, payment, return and print state.
 */
export function startUpdater(deps: StartUpdaterDeps): void {
  deps.updateService.start();
}
