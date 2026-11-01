import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  powerMonitor,
  safeStorage,
  session,
} from 'electron';
import * as Sentry from '@sentry/electron/main';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSenderGuardedIpcMain } from './ipc/sender-guard.js';
import { createSessionLockGuardedIpcMain } from './ipc/session-lock-guard.js';
import { createRecoveryModeGuardedIpcMain } from './ipc/recovery-mode-guard.js';
import { registerRecoveryHandlers } from './ipc/recovery.js';
import { registerPrinterHandlers } from './ipc/printer.js';
import { bindPrinterSettingRepository } from './printer/printer-setting-repository.js';
import { createPrinterService } from './printer/printer-service.js';
import { type ComposedSaleVoid } from './sale-void/compose-sale-void.js';
import {
  createManagerRecovery,
  createRecoveryPaymentPort,
  type ManagerRecovery,
} from './recovery/manager-recovery.js';
import { createSaleBoundaryIpcMain } from './ipc/sale-boundary-guard.js';
import { registerSessionLockHandlers } from './ipc/session-lock.js';
import { registerResumeStateHandler } from './ipc/resume-state.js';
import { SessionUnlockHandler } from './operator/session-unlock-handler.js';
import { OnlineCredentialVerifier } from './operator/online-credential-verifier.js';
import { ReauthHandler } from './operator/reauth-handler.js';
import { registerReauthHandler } from './ipc/reauth.js';
import { registerCashierPinStatusHandler } from './ipc/cashier-pin-status.js';
import { createLockStateReader, createSafePointProbe } from './operator/lock-state-reader.js';
import { wireSessionStatePush } from './operator/session-state-push.js';
import { wireSessionLockAudit } from './operator/session-lock-audit.js';
import { SESSION_LOCK_IPC_CHANNELS } from '../shared/operator/channels.js';
import { registerPingHandler } from './ipc/ping.js';
import { registerAppVersionHandler } from './ipc/app-version.js';
import { registerLogHandler } from './ipc/log.js';
import { registerAppConfigHandler } from './ipc/app-config.js';
import { registerPairingHandlers } from './ipc/pairing.js';
import { registerOperatorHandlers } from './ipc/operator.js';
import { registerCartHandlers } from './ipc/cart.js';
import { registerCartParkHandlers } from './ipc/cart-park.js';
import { createParkResume } from './cart/park/park-resume.js';
import { bindParkStore } from './cart/park/park-store.js';
import { createCataloguePriceLookup } from './cart/park/resume-diff.js';
import { createCartBridgeHandlers } from './cart/wire-cart-handlers.js';
import { bindCartStore } from './cart/cart-store.js';
import { createHeldCarts, registerHeldCartLifecycle } from './cart/held-carts.js';
import { createHeldAttempts } from './payments/held-attempts.js';
// 009-product-search-and-barcode-lookup S4 (T043) — production R7 resolver.
import { createProductRepo } from './catalogue/product-repo.js';
import { createCatalogueResolver } from './catalogue/resolve-item-ref.js';
import { applyDevSeedCatalogueIfRequested } from './catalogue/dev-seed-catalogue.js';
import { registerPaymentsHandlers } from './ipc/payments.js';
import {
  bindAttemptHasLiveTender,
  bindSessionHasLiveTender,
  bindCartPaymentStatus,
  bindPaymentAttemptsRepository,
} from './payments/repositories/payment-attempts.repository.js';
import { bindCartPaymentEligibility } from './payments/cart-payment-eligibility.js';
import { bindCashShiftGate } from './payments/cash-shift-gate.js';
import { bindPaymentTenderLinesRepository } from './payments/repositories/payment-tender-lines.repository.js';
import { bindPaymentActionOutboxRepository } from './payments/repositories/payment-action-outbox.repository.js';
import { createPaymentAttemptFsm } from './payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from './payments/fsm/tender-line-fsm.js';
import { createIdempotencyHelper } from './payments/idempotency.js';
import { createPaymentAuditEmitter, type PaymentAuditEvent } from './payments/audit-emitter.js';
import {
  bindCheckoutReturnAllowed,
  bindCheckoutReturnGuard,
} from './payments/checkout-return-guard.js';
import { createPaymentsStartHandler } from './payments/handlers/payments-start.js';
import { createPaymentsConfirmHandler } from './payments/handlers/payments-confirm.js';
import { createPaymentsCancelHandler } from './payments/handlers/payments-cancel.js';
import { createPaymentsForceFailHandler } from './payments/handlers/payments-force-fail.js';
import { createPaymentsSubscribeHandler } from './payments/handlers/payments-subscribe.js';
import { createPaymentsReadHandler } from './payments/handlers/payments-read.js';
import { createTenderApplyHandler } from './payments/handlers/tender-apply.js';
import { createTenderReverseHandler } from './payments/handlers/tender-reverse.js';
import { createTenderReadHandler } from './payments/handlers/tender-read.js';
import { createDeferredReversalResolver } from './payments/deferred-reversal-resolver.js';
import { createSettlementCommitter } from './payments/settlement-commit.js';
import { createSettledAuditReconciler } from './payments/settled-audit-reconciler.js';
import {
  reverseVoucher,
  type ReverseVoucherInput,
  type ReverseVoucherOutcome,
} from './payments/voucher-authority-client/reverse.js';
import type { ActionCategory as Audit004ActionCategory } from '../shared/audit/event-shape.js';
import type { OperatorSessionForPayments } from './payments/require-operator-session.js';
import { resolveSessionScope } from './operator/resolve-session-scope.js';
// 011 sale-sync — S5 live HTTP client + engine + status IPC (#349 cleared).
import { composeTerminalStatus } from './terminal-status/compose-terminal-status.js';
import { createTerminalStatusPublisher } from './terminal-status/terminal-status-publisher.js';
import { registerTerminalStatusHandlers } from './ipc/terminal-status.js';
import { TERMINAL_STATUS_IPC_CHANNELS } from '../shared/terminal-status/types.js';
import {
  createPairedWorkers,
  withPairedNotification,
  type PairedWorkers,
} from './app/paired-workers.js';
import {
  composeShiftCashupService,
  pairedShiftScope,
} from './shift-cashup/compose-shift-cashup.js';
import { createManagerCredentialAudit } from './operator/manager-credential-audit.js';
import {
  createManagerPinStore,
  purgeOtherTerminalManagerPinRecords,
} from './operator/manager-pin-store.js';
import { createManagerApprovalService } from './operator/manager-approval-service.js';
import { registerManagerApprovalHandlers } from './ipc/manager-approval.js';
import { postHandoffCancelApprovalResolver } from './cart/post-handoff-approval.js';
import { manualDiscountApprovalResolver } from './cart/discount-approval.js';
import type { SaleAuditEvent } from './sales/audit-emitter.js';
import { createPrintPipeline } from './receipts/print-pipeline.js';
import { createEscposAdapter } from './receipts/escpos-adapter.js';
import { createOsPrintAdapter } from './receipts/os-print-adapter.js';
import { createOsPrintTransport, createDefaultPrintWindow } from './receipts/os-print-transport.js';
import { withPrintRefocus } from './receipts/print-refocus.js';
import type { DrawerKickTransport } from './drawer/drawer-kick-transport.js';
import { randomUUID } from 'node:crypto';
import { createWorkerRegistry } from './app/bootstrap-workers.js';
import { createWindowFactory } from './app/bootstrap-window.js';
import { createDatabaseHolder } from './app/bootstrap-db.js';
import { resolveApiBaseUrl, resolveAuthExchanger, resolveMigrationsDir } from './bootstrap/env.js';
import { registerBranding } from './bootstrap/branding.js';
import { registerCatalogue } from './bootstrap/catalogue.js';
import { registerReturns } from './bootstrap/returns.js';
import { registerSaleVoid } from './bootstrap/sale-void.js';
import { startFinalizeListener } from './bootstrap/finalize.js';
import { startSaleSyncEngine } from './bootstrap/sale-sync.js';
import { registerSalesBridges } from './bootstrap/sales-bridges.js';
import { registerShift } from './bootstrap/shift.js';
import { registerUpdater, startUpdater } from './bootstrap/updater.js';
import {
  getCurrentPrinters,
  resolveRendererOrigin as resolveRendererOriginFor,
} from './bootstrap/window.js';
import {
  assessCashierProfile,
  describeCashierProfileRefusal,
  parseFeatureFlags,
} from './app/feature-flags.js';
import { assessLaunchSwitches } from './app/launch-switch-guard.js';
import { isShippedApp } from './app/shipped-app.js';
import { acquireSingleInstance, restoreAndFocus } from './app/single-instance.js';
import { openDatabase } from './db/client.js';
import { bindMigrationsDb, readMigrationsFromDisk } from './db/migrate.js';
import { bindVacuumInto } from './db/pre-migration-snapshot.js';
import { runStartupMigrations } from './app/startup-migrations.js';
import { trackPrintPipeline } from './update/print-activity.js';
import type { UpdateService } from './update/update-service.js';
import { createSecretStore } from './secrets/index.js';
import { createLogger, waitForLogDrain } from './logging/logger.js';
import { initSentryMain, mainIntegrations } from './observability/sentry-main.js';
import { createRendererErrorReporter } from './observability/renderer-error-report.js';
import { loadBuildIdentity, withBuildIdentity } from './observability/build-identity.js';
import { withRequestId } from './observability/request-id.js';
import { registerReportErrorHandler } from './ipc/report-error.js';
import { bindPairingStoreDb, createPairingStore } from './pairing/store.js';
import { applyDevSkipPairingIfRequested } from './pairing/dev-skip-pairing.js';
import { applyDevSkipOperatorSignInIfRequested } from './operator/dev-skip-operator-signin.js';
import { AuditEmitter } from './audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from './audit/audit-events-store.js';
import { createNetwork } from './pairing/network.js';
import { createPairingService } from './pairing/service.js';
import { createPairingLog } from './pairing/log.js';
import { createBackendClient } from './operator/backend-client.js';
import { SessionManager } from './operator/session-manager.js';
import { CashierSignInHandler, SignInHandler } from './operator/sign-in-handler.js';
import { SignOutHandler } from './operator/sign-out-handler.js';
import {
  createSessionAdmission,
  registerSupersededSessionSignOut,
} from './operator/session-admission.js';
import { createCashierAdmissionClient } from './operator/cashier-admission-client.js';
import type { CashierAdmissionDeps } from './operator/cashier-admission.js';
import { CashierAdmissionKeeper } from './operator/cashier-admission-keeper.js';
import { createOfflineGrantStore } from './operator/offline-grant-store.js';
import {
  createOfflineGrantWiring,
  scopeFromPairingStatus,
  withOfflineGrantPairing,
} from './operator/offline-grant-wiring.js';
import { RosterHandler } from './operator/roster-handler.js';
import { CashierPinStatusHandler } from './operator/cashier-pin-status.js';
import { InactivityMonitor } from './operator/inactivity-monitor.js';
// RT-215 — device-revoked state + pairing recovery.
import {
  createDeviceAuthDetector,
  deviceAuthConfirmDelayMs,
  withDeviceAuthObservation,
} from './pairing/device-auth-detector.js';
import {
  createRevocationRecheckTokenRead,
  createSendableDeviceTokenReader,
} from './pairing/device-token.js';
import {
  createDeviceRevocationFlow,
  createRosterConfirmationProbe,
  deviceRevocationGrantHooks,
  withDeviceRevocationRecovery,
  type DeviceRevocationFlow,
} from './app/device-revocation-flow.js';
import { createRevocationRecheck } from './app/revocation-recheck.js';
import { purgeOtherTerminalPinRecords } from './operator/pin-records-purge.js';
import { registerManagerRoleRefresh } from './operator/manager-pin-enrollment.js';
import { PAIRING_PUSH_CHANNELS, type PairingRecheckResult } from '../shared/pairing-types.js';
import { createJwtHolder } from './operator/jwt-holder.js';
import { ProtoSessionStore, TakeoverHandler } from './operator/takeover-handler.js';
import { PinManagementHandler } from './operator/pin-management.js';
import { ForcedCloseHandler } from './operator/forced-close-handler.js';
import { StuckShiftsHandler } from './operator/stuck-shifts-handler.js';
import { makeSecretKey } from '../shared/secret-store.js';
import type { AppConfig } from '../shared/app-config.js';

/**
 * RT-203 — ONE POS process per terminal. Taken FIRST, before anything else in
 * main is built.
 *
 * A second launch does not get the lock: it quits right here and never opens
 * the database, runs migrations, starts a worker, registers IPC, builds the
 * printer/drawer ports or creates a window. The whole boot below is chained on
 * `singleInstanceReady`, which is `null` for that process.
 *
 * The process-local single-flight structures depend on this lock: sale sync,
 * the catalogue read-down, the finalize listener, the payments deferred-reversal
 * resolver, the returns resolver/dispatcher (and the returns payout), the drawer
 * double-kick guard and printer access. See `app/single-instance.ts` and
 * `docs/architecture/current.md` §3.
 *
 * On a second launch the running instance restores and focuses its cashier
 * window: the tracked `mainWindow`, never "any window" (the hidden offscreen
 * print window is a BrowserWindow too).
 */
let mainWindow: BrowserWindow | undefined;
const singleInstanceReady = acquireSingleInstance(app, () => {
  restoreAndFocus(mainWindow);
});

/**
 * 002-terminal-pairing US1: SecretStore key under which the device
 * token is held. Single source of truth — re-used by the pairing store
 * here AND any future feature that reads the token to set
 * `X-Terminal-Token` on backend calls.
 */
const DEVICE_TOKEN_KEY = makeSecretKey('terminal.device-token');

// __dirname is a CJS global; ESM (NodeNext output) requires this polyfill.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env['NODE_ENV'] === 'development';

/**
 * RT-165 — the trusted shipped-app identity. Every dev/production security
 * decision below (dev bypasses, SecretStore refusal, migrations source) keys
 * on this, never on `app.isPackaged` alone: a renamed copy of the shipped exe
 * reports `isPackaged === false` but still runs the shipped `app.asar`.
 */
const shippedApp = isShippedApp({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
});

/** RT-164 — longest a refused launch waits for its log line to reach disk. */
const LAUNCH_REFUSAL_LOG_DRAIN_MS = 2000;

/** The trusted renderer origin allow-list (#370); the resolver lives in `bootstrap/window.ts`. */
const resolveRendererOrigin = (): string => resolveRendererOriginFor(isDev, __dirname);

/**
 * Window construction and the renderer trust boundary now live in
 * `app/bootstrap-window.ts` (021 S3). The security policy is unchanged — it
 * moved verbatim — but it is now independently testable without launching a
 * real BrowserWindow. `resolveRendererOrigin` is INJECTED rather than moved so
 * it stays the single source of truth (#370) shared with the IPC sender guard
 * wired in `whenReady`.
 */
const buildMainWindow = createWindowFactory({
  isDev,
  BrowserWindow,
  session,
  resolveRendererOrigin,
  preloadPath: path.join(__dirname, '../preload/index.js'),
  rendererFilePath: path.join(__dirname, '../renderer/index.html'),
  devServerUrl: 'http://localhost:5173',
});

/** Build the cashier window and track it as the RT-203 focus target. */
const createWindow = (): void => {
  mainWindow = buildMainWindow();
};

/**
 * 021 S2 — process-lifetime DB handle OWNERSHIP.
 *
 * Opened once in `app.whenReady()`, used by the migration runner and the
 * SecretStore, closed on app quit (R9). Accessed only from the main process —
 * never exposed to the renderer.
 *
 * The handle lives in a holder rather than a module-scope `let` so the
 * shutdown path (which runs outside `whenReady()`) can reach it while every
 * in-`whenReady()` consumer uses a plain local `const db`. Close ordering,
 * failure isolation, and idempotency are owned by the holder.
 */
const dbHolder = createDatabaseHolder({ logger: console });

/**
 * 021 S1 — process-lifetime background-worker teardown.
 *
 * Owns the stop callbacks for the 008 finalize listener, the 010 read-down
 * driver, and the 011 sale-sync interval: fixed stop ordering, failure
 * isolation, and idempotency all live in `app/bootstrap-workers.ts`.
 *
 * Construction stays below, inside the branches that gate each worker (the
 * `sale_finalization` flag; the paired-terminal branch), so a worker that is
 * never started is never registered and `stopAll()` has nothing to stop for it.
 * `closeDbHandle()` drains this registry BEFORE closing the DB handle, so a
 * mid-flight background tick can never run against a closed handle.
 */
const workerRegistry = createWorkerRegistry({ logger: console });

/**
 * RT-772 — the updater's scheduled check. Held at module level (like
 * `pairedWorkers`) so `closeDbHandle()` can stop it before the DB handle closes:
 * a late tick would otherwise read the safe-point inputs from a closed handle.
 */
let updateServiceHandle: UpdateService | null = null;

/**
 * RT-202 — once-latch for the paired-only workers (read-down driver, finalize
 * listener, sale-sync engine). Built inside `whenReady` (it needs the main
 * logger); held here so `closeDbHandle()` can refuse a late start — a pairing
 * that completes while the app is quitting must not build a worker against a DB
 * handle that is about to close.
 */
let pairedWorkers: PairedWorkers | undefined;

singleInstanceReady
  ?.then(async () => {
    // T062 — initialize loggers FIRST inside whenReady, before any
    // other subsystem. `app.getPath('logs')` is only available after
    // `whenReady` fires, so this is the earliest possible site.
    // Two pino instances: one tagged `process: 'main'` writes to
    // main-YYYYMMDD.log; one tagged `process: 'renderer'` writes to
    // renderer-YYYYMMDD.log (records arrive via the app:log IPC).
    const logsDir = app.getPath('logs');
    const appVersion = app.getVersion();
    const mainLogger = await createLogger({
      process: 'main',
      appVersion,
      logsDir,
    });
    const rendererLogger = await createLogger({
      process: 'renderer',
      appVersion,
      logsDir,
    });
    mainLogger.info({ logsDir, appVersion }, 'app:logger-ready');

    // RT-164 — a PACKAGED build refuses debugging switches (`--remote-debugging-*`
    // has no Electron fuse; `--inspect*` is refused here as well as by the fuse).
    // Checked as early as logging allows: before Sentry, the DB, any IPC
    // handler or any window. Only switch NAMES are logged, never their values.
    // pino-roll writes asynchronously and `flush()` does not wait for it, so the
    // exit waits for the stream to drain (bounded) or the line is lost.
    const launchSwitches = assessLaunchSwitches({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      argv: process.argv,
      hasSwitch: (name) => app.commandLine.hasSwitch(name),
    });
    if (!launchSwitches.ok) {
      mainLogger.error(
        { reason: launchSwitches.reason, switches: launchSwitches.switches },
        'app:debug_switch_refused',
      );
      await waitForLogDrain(mainLogger, LAUNCH_REFUSAL_LOG_DRAIN_MS);
      app.exit(1);
      return;
    }

    // T068 — initialise Sentry AFTER the main logger is up but BEFORE
    // migrations / window creation. Sentry's `init` is wrapped in
    // try/catch inside `initSentryMain`; a thrown init logs one warn
    // line via `mainLogger` and the app continues. With `SENTRY_DSN`
    // unset (the default in `.env.example`), Sentry stays inert — no
    // network calls, no crashes (AS-8).
    // RT-634 (OBS-5) — OBS-1 contract: DSN / DEPLOYMENT_ENVIRONMENT /
    // POS_PULSE_RELEASE from the launch env (main only), reviewed
    // integrations only, allowlist beforeSend, bounded offline queue.
    const sentryMain = initSentryMain({
      sentryInit: Sentry.init,
      integrations: () => mainIntegrations(Sentry),
      logger: mainLogger,
      env: process.env,
    });

    // RT-162 (RT-160 FU-1 / owner decision D-1) — fail-closed cashier profile.
    // PAYMENTS on with SALE_FINALIZATION off would settle money with no Sale
    // row, receipt, outbox entry or Backend-Core capture, so it is refused HERE,
    // in trusted main, before the DB opens, before any payment IPC is
    // registered and before the window exists. The dialog is the ASYNC
    // showMessageBox, not showErrorBox: the synchronous one blocks the event
    // loop, and the packaged build showed the async pino write of this log line
    // stalling behind it. We exit explicitly once the dialog closes: without a
    // window, `window-all-closed` never fires and the process would linger.
    const startupFeatureFlags = parseFeatureFlags(process.env);
    const cashierProfile = assessCashierProfile(startupFeatureFlags);
    if (!cashierProfile.ok) {
      mainLogger.error(
        { reason: cashierProfile.reason, features: startupFeatureFlags },
        'app:cashier_profile_refused',
      );
      const refusal = describeCashierProfileRefusal(cashierProfile.reason);
      const exitRefused = (): void => {
        app.exit(1);
      };
      void dialog
        .showMessageBox({ type: 'error', title: refusal.title, message: refusal.body })
        .then(exitRefused, exitRefused);
      return;
    }

    // T040 + R9 — open ONE shared DB handle, run migrations, then keep
    // the handle alive for the SecretStore. Failure during migrations
    // rethrows into the .catch below, which calls app.exit(1).
    const dbPath = path.join(app.getPath('userData'), 'pos-pulse.db');
    const db = openDatabase(dbPath);
    dbHolder.set(db);
    mainLogger.info({ dbPath }, 'db:opened');

    // RT-320 — roll-forward safety (ADR-0006): refuse a DB a newer build has
    // migrated, and snapshot to <userData>/backups/ before pending migrations.
    const files = readMigrationsFromDisk(resolveMigrationsDir(shippedApp));
    const migrated = runStartupMigrations({
      db: bindMigrationsDb(db),
      files,
      vacuumInto: bindVacuumInto(db),
      userDataDir: app.getPath('userData'),
      now: () => new Date(),
      logger: mainLogger,
    });
    if (!migrated.ok) {
      // Same async-dialog-then-exit shape as the cashier-profile refusal above.
      closeDbHandle();
      const exitRefused = (): void => {
        app.exit(1);
      };
      void dialog
        .showMessageBox({
          type: 'error',
          title: migrated.refusal.title,
          message: migrated.refusal.body,
        })
        .then(exitRefused, exitRefused);
      return;
    }
    mainLogger.info({ count: files.length }, 'db:migrations-applied');

    // 009 T049b — dev-only catalogue fixture seed. Fail-closed: no-op in the
    // shipped app (the env var is never consulted there; RT-165) and unless
    // POS_PULSE_DEV_SEED_CATALOGUE is truthy. Lets the live T049a surface +
    // S5 review tasks exercise real rows. Meant to run alongside the
    // POS_PULSE_DEV_SKIP_* flags (same dev-tenant).
    applyDevSeedCatalogueIfRequested({
      isPackaged: shippedApp,
      env: process.env,
      db: db,
      logger: mainLogger,
    });

    // T048 wire-in: construct the SecretStore on the same long-lived
    // handle to validate factory wiring (production refusal will throw
    // into .catch below per R8). 002 US1 retains the reference because
    // the pairing store now consumes it.
    const secretStore = createSecretStore({
      handle: db,
      safeStorage,
      isPackaged: shippedApp,
    });
    // Note (Phase 5 R8): SecretStore still uses console.warn/error
    // placeholders. Swap to mainLogger is a deferred follow-up — out
    // of Phase 8 scope.

    // RT-113 P1.2 — the sealed offline grant store, wired: the cashier-admission
    // grant seam (below), the pairing purge + new epoch on every pairing change
    // (the wrapper; `src/main/pairing/` is untouched), and the 60 s clock tick
    // (OD7), stopped with the other workers before the DB closes (RT-198 latch).
    const offlineGrants = createOfflineGrantWiring({
      store: createOfflineGrantStore({
        db,
        safeStorage,
        now: () => new Date(),
        logger: mainLogger,
      }),
      audit: new AuditEmitter(bindAuditEventsStoreDb(db)),
      uuid: () => randomUUID(),
      now: () => new Date(),
      logger: mainLogger,
    });

    // 002-terminal-pairing T011/T013 — construct the pairing store on
    // the shared DB handle + SecretStore. The store is the only module
    // that touches both halves of pairing state.
    const pairingStore = withOfflineGrantPairing(
      createPairingStore({
        secretStore,
        db: bindPairingStoreDb(db),
        deviceTokenKey: DEVICE_TOKEN_KEY,
      }),
      offlineGrants,
    );
    offlineGrants.setScope(scopeFromPairingStatus(await pairingStore.getStatus()));
    offlineGrants.start();
    workerRegistry.register('offline grant clock tick', () => {
      offlineGrants.stop();
    });
    // RT-215 — the ONE reader of the device token for sending: null unless the
    // pairing is `paired`, so a revoked device never sends its (still sealed)
    // token. The revocation flow is built further down (it needs the keeper);
    // it is late-bound here, like `saleBoundaryProbe`.
    const readSendableDeviceToken = createSendableDeviceTokenReader({
      pairingStore,
      secretStore,
      deviceTokenKey: DEVICE_TOKEN_KEY,
    });
    const deviceRevocation: Pick<DeviceRevocationFlow, 'onConfirmed' | 'onPaired'> & {
      hasSession: () => boolean;
      /** RT-215 10897-A — the "Check again" (`pairing:recheck`), bound below. */
      recheck: () => Promise<PairingRecheckResult>;
    } = {
      onConfirmed: () => undefined,
      onPaired: () => Promise.resolve(),
      hasSession: () => false,
      recheck: () => Promise.resolve({ outcome: 'unreachable' }),
    };

    // 002-terminal-pairing dev bypass — seeds fixture pairing state so the
    // renderer routes past /pairing in unpackaged dev builds.
    // SECURITY: the shipped-app guard is inside applyDevSkipPairingIfRequested;
    // this call is a no-op in the shipped app (renamed exe included, RT-165)
    // regardless of env vars.
    await applyDevSkipPairingIfRequested({
      isPackaged: shippedApp,
      env: process.env,
      pairingStore,
      logger: mainLogger,
    });

    // 002-terminal-pairing T021/T023/T025 — construct the pairing
    // service. The service composes network.pair() + pairingStore.persist()
    // + a schema-restricted pairingLog. Resolve-on-reachable, reject-only-
    // on-transport network contract is locked from PR #17. The IPC
    // handler below routes `pairing:submit` here.
    // RT-634 (OBS-5) — every Backend-Core call carries a fresh UUID
    // `X-Request-Id` (OBS-1 contract §2), logged locally with method, path
    // and status. ONE wrapper on the base fetch; all Backend-Core clients
    // below are built on it. The identity provider exchanger (Descope,
    // resolveAuthExchanger) is not wrapped.
    // RT-719 — the build identity (`X-POS-Build-Commit`, `X-POS-Contract-Pin`) rides
    // the same shared fetch: added only on the device-token requests of the thirteen
    // reporting operations, omitted whenever the build has no honest identity.
    const buildIdentity = loadBuildIdentity(
      path.join(app.getAppPath(), 'dist', 'build-identity.json'),
    );
    mainLogger.info({ build_identity_known: buildIdentity !== null }, 'build_identity:loaded');
    const backendBaseFetch = withBuildIdentity(
      withRequestId(globalThis.fetch.bind(globalThis), {
        logger: mainLogger,
      }),
      {
        baseUrl: resolveApiBaseUrl(),
        identity: () => buildIdentity,
        readDeviceToken: readSendableDeviceToken,
      },
    );
    const pairingNetwork = createNetwork({
      fetch: backendBaseFetch,
      baseUrl: resolveApiBaseUrl(),
    });
    // RT-202 — pairing happens in the renderer WITHOUT a process relaunch, so the
    // paired-only workers cannot be bound only at boot. They register a starter
    // with this latch (at the sites below); it fires at boot when already paired
    // and, for a first-run terminal, right after the pairing is persisted.
    const pairedWorkersLatch = createPairedWorkers({ logger: mainLogger });
    pairedWorkers = pairedWorkersLatch;
    // Re-read the scope from the pairing store (not from the submit result) so the
    // workers bind the SAME terminal_id payments writes (#380 / F-007 lockstep).
    const notifyPairedFromStore = async (): Promise<void> => {
      try {
        const status = await pairingStore.getStatus();
        if (status.kind !== 'paired') return;
        pairedWorkersLatch.notifyPaired({
          tenant_id: status.tenant_id,
          branch_id: status.branch_id,
          terminal_id: status.terminal_id,
        });
      } catch (err) {
        mainLogger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'paired_workers:notify_failed',
        );
      }
    };
    // The ONLY pairing service handed to the IPC handler is the wrapped one, so a
    // successful in-process pairing always notifies the latch. `src/main/pairing/`
    // itself is unchanged.
    // RT-215: every successful pairing also runs the recovery step (detector
    // reset, other terminals' PIN records deleted, revocation-cleared audit).
    const pairingService = withPairedNotification(
      withDeviceRevocationRecovery(
        createPairingService({
          store: pairingStore,
          network: pairingNetwork,
          pairingLog: createPairingLog(mainLogger),
          clock: () => new Date(),
        }),
        {
          getStatus: () => pairingStore.getStatus(),
          onPaired: (input) => deviceRevocation.onPaired(input),
          // Review F3: no pairing while an operator session is alive.
          hasSession: () => deviceRevocation.hasSession(),
        },
      ),
      notifyPairedFromStore,
    );

    // #370 (LOW hardening) — wrap ipcMain ONCE so every handler is sender-origin
    // guarded (defense-in-depth on the renderer→main trust boundary). Uses the
    // SAME `resolveRendererOrigin()` the `will-navigate` allow-list uses, so the
    // navigation check and the IPC check cannot drift. Every `register…` below
    // receives the guarded instance — zero registrar edits (they take IpcMain).
    // RT-117 (RT-116 §2.5) — wrap ONCE more so every handler is refused while
    // the operator session is LOCKED unless its channel is on the allowlist.
    // The session manager is built below; bind the probe to it there.
    const sessionLockProbe: { isLocked: () => boolean } = { isLocked: () => false };
    // RT-113 P2 — after EVERY cart/payments/tender call, re-check whether a
    // session that lost its authority has reached its safe point (one choke
    // point; bound to the keeper once it is built below).
    const saleBoundaryProbe: { recheck: () => void } = { recheck: () => undefined };
    // RT-441 (RT-116 §5.1) — a recovery-mode session may not sell: every
    // cart / payments / tender / vouchers / returns call is refused.
    const recoveryModeProbe: { active: () => boolean } = { active: () => false };
    const guardedIpcMain = createSaleBoundaryIpcMain(
      createRecoveryModeGuardedIpcMain(
        createSessionLockGuardedIpcMain(
          createSenderGuardedIpcMain(ipcMain, resolveRendererOrigin()),
          () => sessionLockProbe.isLocked(),
        ),
        () => recoveryModeProbe.active(),
      ),
      () => {
        saleBoundaryProbe.recheck();
      },
    );

    // Register IPC handlers BEFORE the first window loads so the renderer's
    // first call cannot race the registration.
    registerPingHandler(guardedIpcMain);
    registerAppVersionHandler(guardedIpcMain);
    registerLogHandler(guardedIpcMain, rendererLogger);
    // RT-634 (OBS-5) — the renderer runs no Sentry SDK and never sees the
    // DSN: an uncaught renderer error arrives here, is validated, capped and
    // rate-limited, then captured in MAIN (same allowlist + offline queue).
    registerReportErrorHandler(
      guardedIpcMain,
      createRendererErrorReporter({
        captureException: (error, hint) => Sentry.captureException(error, hint),
        isEnabled: () => sentryMain.kind === 'initialized',
        logger: rendererLogger,
      }),
    );
    // T067 + D3 — renderer runtime config crosses the typed bridge; never
    // via `import.meta.env.VITE_*` (which would inline it into the
    // renderer bundle at build time).
    const getAppConfig = (): AppConfig => {
      const cfg: AppConfig = {};
      // 005 cart / 006 payments / 008 saleFinalization / 009 productSearch /
      // RT-103 voucherTender / RT-15 returns / RT-700 cardTender — every flag defaults false (fail-closed).
      // RT-162: parsing lives in `app/feature-flags.ts` (one truthy parser,
      // unchanged semantics). Re-parsed per call, as before; the PAYMENTS-
      // without-SALE_FINALIZATION profile never reaches here (refused at startup).
      cfg.features = parseFeatureFlags(process.env);
      return cfg;
    };
    registerAppConfigHandler(guardedIpcMain, getAppConfig);

    // 002-terminal-pairing T013 + T025 — wire BOTH pairing channels.
    // T025 lands `pairing:submit`; the SUBMIT handler validates the
    // argument shape and forwards the service result unchanged.
    // RT-215 10897-A: + `pairing:recheck` (the "Check again"; late-bound below).
    registerPairingHandlers(guardedIpcMain, {
      store: pairingStore,
      service: pairingService,
      recheck: () => deviceRevocation.recheck(),
    });

    // 004-operator-session — wire `operator.*` IPC.
    //
    // Identity-provider (Descope) credential exchange happens HERE in the
    // main process; the password NEVER reaches Backend-Core (Wave 1 path b /
    // AD-2 / Constitution v1.5.1). If `DESCOPE_PROJECT_ID` is unset or
    // malformed, we wire a stub exchanger that always refuses — the app still
    // launches and `/sign-in` is reachable, but submit fails with the generic
    // refusal copy.
    // RT-215 (Codex P1): neither holder accepts a credential while the device
    // is revoked, so a sign-in that completes late cannot repopulate one.
    const refuseWhileRevoked = { refuseWhile: () => pairingStore.isDeviceRevoked() };
    const operatorJwtHolder = createJwtHolder(refuseWhileRevoked);
    // 016 (review HIGH) — the SECOND credential seam. DP-2 splits POS auth:
    //   • operatorJwtHolder holds the provider JWT (`operator-identity`) for
    //     sign-out + stuck-shifts + the takeover/confirm CALL (028 §6 CM-1).
    //   • operatorEnvelopeHolder holds the opaque pos_operator ENVELOPE (#559,
    //     `operatorAuthorization`) read ONLY by the sale-sync getOperatorToken
    //     closures. Keyed on backend_session_id, in-process only, never bridged.
    const operatorEnvelopeHolder = createJwtHolder(refuseWhileRevoked);
    const operatorSessionManager = new SessionManager();

    // RT-772 / RT-322 — the POS updater and its status bridge (bootstrap/updater.ts, RT-893).
    // Built here, before the shift close paths and the print dispatcher that report to it.
    const { updateService, printActivity } = registerUpdater({
      guardedIpcMain,
      db,
      shippedApp,
      operatorSessionManager,
      mainLogger,
    });
    updateServiceHandle = updateService;
    sessionLockProbe.isLocked = () => operatorSessionManager.isLocked();
    recoveryModeProbe.active = () => operatorSessionManager.getCurrent()?.recovery_of !== undefined;
    // RT-444 (RT-116 S3, §4) — ONE sign-in admission guard for every path
    // (manager, cashier PIN, both takeover confirms). It refuses another
    // operator while this terminal holds unresolved payment, and ends a locked
    // session explicitly (`superseded_at_lock`) before the new one is created.
    // The audit emitter is built below; the guard only emits on a sign-in.
    const sessionAdmission = createSessionAdmission({
      db,
      sessionManager: operatorSessionManager,
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
      auditEmitter: {
        emit: (event) => {
          auditEmitter.emit(event);
        },
      },
      logger: mainLogger,
    });
    const apiBaseUrl = resolveApiBaseUrl();
    // RT-601 (VN-S6 S6-1a) — the connection monitor's passive feeder. Every
    // Backend-Core device and operator fetch below is built on `backendFetch`,
    // which only OBSERVES the transport outcome (an HTTP status or a fault) and
    // passes request and response through untouched. Transitions are logged as
    // `{ from, to }`. Bridged by RT-603 (S6-2) below.
    // RT-602 (VN-S6 S6-1b) — the active feeder: a credential-free GET of
    // Backend-Core's public liveness endpoint, only while the passive feeder is
    // idle (§2.5 cadence). It uses the UNOBSERVED fetch: the probe reports its
    // own outcome and must not count as passive traffic. `powerMonitor` resume
    // → checking; a `net.isOnline()` drop → offline. The worker's stop ends the
    // probe and removes the resume listener.
    const terminalStatus = composeTerminalStatus({
      logger: mainLogger,
      probe: {
        baseUrl: apiBaseUrl,
        // Quiet: the idle probe runs every 10 s, so its ids log at debug.
        fetch: withRequestId(globalThis.fetch.bind(globalThis), {
          logger: mainLogger,
          quiet: true,
        }),
        isInterfaceOnline: () => net.isOnline(),
        powerMonitor,
      },
    });
    workerRegistry.register('terminal status tick', () => {
      terminalStatus.stop();
    });
    // RT-603 (VN-S6 S6-2) — the terminal status bridge. `terminalStatus:get` is
    // registered HERE, at app start on the guarded ipcMain (sender guard; not
    // session-gated; not on the locked allowlist, D-6-10), so an unpaired
    // terminal is answered `checking` rather than refused. The push goes to the
    // app windows only, on change and at most once a second. Unpaired or revoked
    // → `checking`; the sync axis stays empty until the paired sale-sync starter
    // binds its reader below. Closed-set codes, counts and ISO times only.
    const terminalStatusPublisher = createTerminalStatusPublisher({
      readConnection: () => terminalStatus.monitor.snapshot(),
      isDeviceGated: () =>
        pairingStore.getCurrentTerminalId() === null || pairingStore.isDeviceRevoked(),
      // Each window independently: a closing one must not starve the others.
      send: (snapshot) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
          try {
            win.webContents.send(TERMINAL_STATUS_IPC_CHANNELS.CHANGED, snapshot);
          } catch {
            // Skip it; the next change reaches the windows still open.
          }
        }
      },
      now: Date.now,
      monotonicNow: () => performance.now(),
      logger: mainLogger,
    });
    terminalStatusPublisher.start();
    workerRegistry.register('terminal status push', () => {
      terminalStatusPublisher.stop();
    });
    registerTerminalStatusHandlers(guardedIpcMain, {
      read: () => terminalStatusPublisher.read(),
    });
    const backendFetch = terminalStatus.observeFetch(backendBaseFetch);
    const operatorBackend = createBackendClient({
      baseUrl: apiBaseUrl,
      fetch: backendFetch,
    });
    const operatorProtoStore = new ProtoSessionStore();
    const identityExchanger = resolveAuthExchanger(mainLogger);
    const deviceTokenAttestation = async (): Promise<string> =>
      (await readSendableDeviceToken()) ?? '';
    const operatorSignInHandler = new SignInHandler({
      // RT-215 (Codex P1): a late success under a revoked/replaced pairing is dropped.
      pairingEpoch: () => pairingStore.getPairingEpoch(),
      clerk: identityExchanger,
      backend: operatorBackend,
      sessionManager: operatorSessionManager,
      // 016 (review HIGH): JWT → operator-identity holder; envelope → sale-sync holder.
      jwtHolder: operatorJwtHolder,
      envelopeHolder: operatorEnvelopeHolder,
      protoStore: operatorProtoStore,
      // Wave 1: device-token attestation = the device token itself
      // (read from SecretStore via the pairingStore). The backend
      // verifies it server-side. The token is NEVER logged.
      deviceTokenAttestation,
      sessionAdmission,
      logger: mainLogger,
    });
    // RT-215 — the ONE device-401 detector. Every device-bearer client below
    // (cashier admissions: sign-in, takeover, heartbeat, roster, end; the
    // catalogue read-down) is built on its observed fetch. Revocation needs two
    // consecutive device 401s, the second from a roster call min(30 s, TTL/2)
    // later on an UNOBSERVED client; a device-bearer 2xx in between resets it.
    // Operator-credential routes are ignored. (This replaces the RT-113 P2
    // immediate cascade on a single 401.)
    const deviceGrantHooks = deviceRevocationGrantHooks(offlineGrants);
    const deviceAuthDetector = createDeviceAuthDetector({
      probe: createRosterConfirmationProbe(
        createCashierAdmissionClient({
          baseUrl: apiBaseUrl,
          fetch: backendFetch,
          getDeviceToken: readSendableDeviceToken,
        }),
      ),
      confirmDelayMs: () =>
        deviceAuthConfirmDelayMs(operatorSessionManager.getCurrent()?.admission_ttl_seconds),
      onConfirmed: (source) => {
        deviceRevocation.onConfirmed(source);
      },
      // Review F4 / OD5 (+ rev546b F-A): EVERY device 401 from any observed
      // source invalidates every offline grant through the seam.
      onUnauthorized: () => {
        deviceGrantHooks.onUnauthorized();
      },
      logger: mainLogger,
    });
    // Review F5: each device-bearer client gets its OWN observed fetch, tagged
    // with its route family and base URL (a path-prefixed base still matches).
    const admissionsFetch = withDeviceAuthObservation(backendFetch, deviceAuthDetector, {
      source: 'cashier_admissions',
      baseUrl: apiBaseUrl,
    });

    // RT-113 P2 (10763 D2/D11, owner decision 10844; fixes RT-182) — the
    // cashier path's server authority: the device-authenticated Backend-Core
    // cashier-admissions resource. Device token as the bearer, read in-process
    // per call; never logged, never bridged. No Clerk-gated call remains on
    // the cashier path.
    const cashierAdmissionClient = createCashierAdmissionClient({
      baseUrl: apiBaseUrl,
      fetch: admissionsFetch,
      getDeviceToken: readSendableDeviceToken,
    });
    const cashierAdmission: CashierAdmissionDeps = {
      client: cashierAdmissionClient,
      // RT-113 P1.2 — the sealed offline grant store (OD5/OD6, fail closed).
      grantSeam: offlineGrants.seam,
    };
    const operatorCashierSignInHandler = new CashierSignInHandler({
      // RT-215 (Codex P1): a late success under a revoked/replaced pairing is dropped.
      pairingEpoch: () => pairingStore.getPairingEpoch(),
      db: db,
      safeStorage,
      sessionManager: operatorSessionManager,
      admission: cashierAdmission,
      pairingStore,
      protoStore: operatorProtoStore,
      secretStore,
      sessionAdmission,
      // RT-308 (RT113-P3) — Backend-Core unreachable: admit the cashier only
      // from a valid sealed grant on this terminal (one use persisted first).
      offline: {
        grants: offlineGrants,
        audit: new AuditEmitter(bindAuditEventsStoreDb(db)),
        uuid: () => randomUUID(),
        now: () => new Date(),
        monotonicNow: () => performance.now(),
        logger: mainLogger,
      },
      logger: mainLogger,
    });
    const operatorSignOutHandler = new SignOutHandler({
      backend: operatorBackend,
      sessionManager: operatorSessionManager,
      // 016 (review HIGH): sign-out is an `operator-identity` route — present the
      // provider JWT from the JWT holder, NOT the sale-sync envelope.
      jwtFor: (sessionId) => operatorJwtHolder.get(sessionId),
      // Sign-out teardown clears BOTH credential seams for the ended session so
      // neither the JWT nor the envelope lingers in main-process memory (P7).
      clearJwt: (sessionId) => {
        operatorJwtHolder.clear(sessionId);
        operatorEnvelopeHolder.clear(sessionId);
      },
      // RT-358 (Q3 = A): an expired JWT skips the backend call unless it was
      // just re-authenticated (its fresh mark bypasses the clock check).
      hasFreshReauthMark: (sessionId) =>
        operatorJwtHolder.hasFreshMark(sessionId, performance.now()),
      // RT-444 (RT-116 §3.4) — refused while the session holds live tender.
      sessionHasLiveTender: bindSessionHasLiveTender(db),
      logger: mainLogger,
    });
    // RT-444 (RT-116 §3.3) — a superseded manager session signs out of the backend too.
    registerSupersededSessionSignOut({
      sessionManager: operatorSessionManager,
      backend: operatorBackend,
      jwtFor: (sessionId) => operatorJwtHolder.get(sessionId),
      clearCredentials: (sessionId) => {
        operatorJwtHolder.clear(sessionId);
        operatorEnvelopeHolder.clear(sessionId);
      },
      logger: mainLogger,
    });
    const operatorRosterHandler = new RosterHandler({
      cashierAdmissions: cashierAdmissionClient,
      // RT-308 (D11) — offline: only cashiers with a valid grant on this terminal.
      offlineCashiers: () => offlineGrants.listAdmissible(new Date()),
      logger: mainLogger,
    });
    const operatorInactivityMonitor = new InactivityMonitor({
      sessionManager: operatorSessionManager,
      // RT-117 — a lock leaves a log line (RT-112: a timeout left none).
      logger: mainLogger,
    });
    operatorInactivityMonitor.start();

    // T048 — construct the audit-events outbox chain on the shared DB handle.
    // Lazy statement preparation in bindAuditEventsStoreDb ensures migration
    // T045 has already run before the first emit call.
    const auditEventsStore = bindAuditEventsStoreDb(db);
    const auditEmitter = new AuditEmitter(auditEventsStore);

    // RT-438 / RT-443 (MA-1 / MA-2) — the terminal's one manager PIN store
    // (RT-17's records, sealed with safeStorage; lifecycle audited) and the
    // approval service that verifies it for a manager-approved action. One
    // instance, so every attempt on a record is serialised in one queue.
    const managerPins = createManagerPinStore({
      db,
      safeStorage,
      onEvent: createManagerCredentialAudit({
        auditEmitter,
        logger: mainLogger,
      }),
    });
    // RT-861 — each online manager / admin sign-in writes its role onto that
    // manager's PIN record (the cashier discount's `approver_role`), whatever
    // the shift cash-up flag says.
    registerManagerRoleRefresh({
      onSessionStarted: (listener) => {
        operatorSessionManager.onStarted(listener);
      },
      store: managerPins,
      currentTerminalId: () => pairingStore.getCurrentTerminalId(),
    });
    const recoveryRef: { current: ManagerRecovery | null } = { current: null };
    // RT-554 (b) — "drain the shift outbox now", set once the shift sync engine
    // starts (paired, flag on); null until then, so a forced close is only queued.
    const shiftSyncDrainNowRef: { current: (() => Promise<boolean>) | null } = { current: null };
    // RT-530 — the sale void's approval subject, bound below once the domain exists.
    const saleVoidRef: { current: ComposedSaleVoid | null } = { current: null };
    const managerApprovals = createManagerApprovalService({
      db,
      getSession: () => operatorSessionManager.getCurrent(),
      isSessionLocked: () => operatorSessionManager.getCurrent()?.lock_state === 'locked',
      currentTerminalId: () => pairingStore.getCurrentTerminalId(),
      managerPins,
      resolvers: {
        'cart.cancel_post_handoff': postHandoffCancelApprovalResolver(bindCartStore(db)),
        // RT-608 — a cashier's manual discount: this cart, line and kind, at this line version.
        'cart.discount.manual': manualDiscountApprovalResolver(bindCartStore(db)),
        // RT-530 — a finalized sale's void: bound to the sale, its total and its requester.
        'sale.void': (input) => saleVoidRef.current?.service.approvalSubject(input) ?? null,
        // RT-441 — manager recovery (bound below, once the payment path exists).
        'recovery.complete_attempt': (input) =>
          recoveryRef.current?.resolvers.completeAttempt(input) ?? null,
        'recovery.cancel_attempt': (input) =>
          recoveryRef.current?.resolvers.cancelAttempt(input) ?? null,
        'recovery.cancel_held_cart': (input) =>
          recoveryRef.current?.resolvers.cancelHeldCart(input) ?? null,
      },
      auditEmitter,
      now: () => new Date().toISOString(),
    });
    registerManagerApprovalHandlers(guardedIpcMain, {
      service: managerApprovals,
      logger: mainLogger,
    });

    // RT-117 (RT-116 S1) — inactivity LOCK of the existing session.
    //   • push: main tells the renderer the moment the session locks/unlocks/
    //     ends (state only — no ids, names or credentials);
    //   • audit: operator.session.locked / operator.session.unlocked;
    //   • IPC: same-operator unlock + the lock-screen totals read (both on the
    //     locked-session allowlist).
    wireSessionStatePush({
      sessionManager: operatorSessionManager,
      send: (event) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(SESSION_LOCK_IPC_CHANNELS.SESSION_STATE, event);
        }
      },
      logError: (err) => {
        mainLogger.error({ err }, 'operator.session_state_push:failed');
      },
    });
    wireSessionLockAudit({
      sessionManager: operatorSessionManager,
      auditEmitter,
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
      uuid: () => randomUUID(),
      logError: (err) => {
        mainLogger.error({ err }, 'operator.session_lock_audit:failed');
      },
    });
    const getOperatorLockState = createLockStateReader({
      db,
      sessionManager: operatorSessionManager,
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
    });
    // RT-358 (RT-247 D-A1) — ONE online credential check for the manager
    // online unlock and the in-place re-auth: one lockout, one in-flight gate.
    const onlineCredentialVerifier = new OnlineCredentialVerifier({ clerk: identityExchanger });
    registerSessionLockHandlers(guardedIpcMain, {
      unlockHandler: new SessionUnlockHandler({
        sessionManager: operatorSessionManager,
        verifyCashierPin: (operator_id, pin) =>
          operatorCashierSignInHandler.verifyPin(operator_id, pin),
        clerk: identityExchanger,
        onlineVerifier: onlineCredentialVerifier,
        // Q2 = yes: the online unlock keeps its fresh JWT (with the one-shot mark).
        jwtHolder: operatorJwtHolder,
        isDeviceRevoked: () => pairingStore.isDeviceRevoked(),
        logger: mainLogger,
      }),
      getLockState: getOperatorLockState,
    });
    // RT-424 (RT-251 doc 19 §2) — manager-only cashier PIN status for
    // Manager → Cashiers. Device roster + this terminal's PIN rows; read-only.
    registerCashierPinStatusHandler(guardedIpcMain, {
      cashierPinStatusHandler: new CashierPinStatusHandler({
        db,
        sessionManager: operatorSessionManager,
        pairingStore,
        cashierAdmissions: cashierAdmissionClient,
        logger: mainLogger,
      }),
      logger: mainLogger,
    });
    registerReauthHandler(guardedIpcMain, {
      reauthHandler: new ReauthHandler({
        sessionManager: operatorSessionManager,
        verifier: onlineCredentialVerifier,
        jwtHolder: operatorJwtHolder,
        isDeviceRevoked: () => pairingStore.isDeviceRevoked(),
        logger: mainLogger,
      }),
    });

    // RT-352 (RT-116 S4a, RT-115 D3.2) — a draft cart outlives its session: it
    // is held for its operator on this terminal and re-attached at that
    // operator's next sign-in, including after a restart. Read once by the
    // renderer after sign-in through `operator.getResumeState()`.
    const heldCarts = createHeldCarts({
      db,
      cartStore: bindCartStore(db),
      auditEmitter,
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
      // RT-442 (RT-116 S5) — the payment side of a held frozen cart. The FSM and
      // payment audit are built below; this runs only at a sign-in or session end.
      attempts: createHeldAttempts({
        db,
        paymentAttemptFsm: {
          cancel: (input) => paymentAttemptFsm.cancel(input),
        },
        auditEmitter: {
          emitPaymentCancelled: (input) => {
            paymentAuditEmitter.emitPaymentCancelled(input);
          },
          emitRaw: (event) => {
            paymentAuditEmitter.emitRaw(event);
          },
        },
        uuid: () => randomUUID(),
        clock: () => new Date(),
      }),
    });
    registerHeldCartLifecycle({
      sessionManager: operatorSessionManager,
      heldCarts,
      logger: mainLogger,
    });
    registerResumeStateHandler(guardedIpcMain, {
      getResumeState: () => heldCarts.getResumeState(operatorSessionManager.getCurrent()),
      logger: mainLogger,
    });

    // RT-113 P2 — keep the online cashier admission live (heartbeat at ≤ TTL/2
    // with a fresh key) and end it on sign-out / session end (best-effort).
    // Lost authority (taken over elsewhere, 403, two consecutive device 401s)
    // latches the session (cart.create, and an add to an empty cart, refuse
    // `authority_conflict`) and ends
    // it at its first safe point: no open sale with lines (the RT-117 lock
    // summary is null) and no live tender on ANY cart of the session
    // (`createSafePointProbe`, review of 024f07c items 2 and 5).
    // Re-checked after every sale IPC call (sale-boundary-guard), on lock
    // changes and by a backstop poll. Stopped on quit with the other workers (RT-198
    // latch: nothing runs after stop).
    const isCashierAtSafePoint = createSafePointProbe({
      db,
      sessionManager: operatorSessionManager,
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
    });
    const cashierAdmissionKeeper = new CashierAdmissionKeeper({
      sessionManager: operatorSessionManager,
      admission: cashierAdmission,
      isAtSafePoint: isCashierAtSafePoint,
      logger: mainLogger,
    });
    saleBoundaryProbe.recheck = () => {
      cashierAdmissionKeeper.recheckSafePoint();
    };
    workerRegistry.register('cashier admission heartbeat', () => {
      cashierAdmissionKeeper.stop();
      // RT-215: the device-401 detector's pending confirmation stops with it.
      deviceAuthDetector.stop();
    });

    // RT-215 — what a CONFIRMED revocation does: record it on the pairing row
    // (the token is then never sent), clear the credential holders, invalidate
    // the offline grants through the existing seam, latch the session at once
    // and end it at its safe point (the keeper), audit it (`system:device`,
    // `{source}`), and push `pairing:status-changed` to route to recovery.
    const deviceRevocationFlow = createDeviceRevocationFlow({
      markDeviceRevoked: () => pairingStore.markDeviceRevoked(),
      getStatus: () => pairingStore.getStatus(),
      sessions: operatorSessionManager,
      isDeviceRevoked: () => pairingStore.isDeviceRevoked(),
      // Review F2: after a re-pair in a process whose paired-only workers ran.
      workersAlreadyStarted: () => pairedWorkersLatch.hasStarted(),
      relaunch: () => {
        app.relaunch();
        app.exit(0);
      },
      latchSession: () => {
        cashierAdmissionKeeper.latchCurrentSession('terminal_session_terminated');
      },
      clearCredentials: () => {
        operatorJwtHolder.clearAll();
        operatorEnvelopeHolder.clearAll();
      },
      // RT-113 P1.2 seam (never the store): invalidate every grant AND
      // clear the grant scope (review F4).
      invalidateGrants: () => {
        deviceGrantHooks.onConfirmed();
      },
      resetDetector: () => {
        deviceAuthDetector.reset();
      },
      purgeOtherTerminalPins: (terminalId) =>
        purgeOtherTerminalPinRecords(db, terminalId) +
        purgeOtherTerminalManagerPinRecords(db, terminalId),
      pushStatus: (event) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(PAIRING_PUSH_CHANNELS.STATUS_CHANGED, event);
        }
      },
      audit: auditEmitter,
      uuid: () => randomUUID(),
      now: () => new Date(),
      logger: mainLogger,
    });
    deviceRevocation.onConfirmed = (source) => {
      deviceRevocationFlow.onConfirmed(source);
    };
    deviceRevocation.onPaired = (input) => deviceRevocationFlow.onPaired(input);
    deviceRevocation.hasSession = () => operatorSessionManager.getCurrent() !== null;
    // RT-215 10897-A (owner approval 10906) — the user-initiated "Check again"
    // on /pairing while revoked: ONE roster call with the sealed token, read
    // through the narrow recheck reader (the default send paths stay null) on
    // an UNOBSERVED client (its answer is never a 2×401 detector count). A 2xx
    // clears the revocation through the flow, then re-binds what the
    // revocation unbound exactly as boot does: the offline grant scope, and the
    // paired-only workers if they never started. Same pairing, so no relaunch.
    deviceRevocation.recheck = createRevocationRecheck({
      probe: createRosterConfirmationProbe(
        createCashierAdmissionClient({
          baseUrl: apiBaseUrl,
          fetch: backendFetch,
          getDeviceToken: createRevocationRecheckTokenRead({
            pairingStore,
            secretStore,
            deviceTokenKey: DEVICE_TOKEN_KEY,
          }),
        }),
      ),
      store: pairingStore,
      onCleared: (scope) => {
        deviceRevocationFlow.onRecheckCleared(scope);
      },
      rebindPaired: async () => {
        offlineGrants.setScope(scopeFromPairingStatus(await pairingStore.getStatus()));
        await notifyPairedFromStore();
      },
      logger: mainLogger,
    });

    const operatorTakeoverHandler = new TakeoverHandler({
      // RT-215 (Codex P1): a late success under a revoked/replaced pairing is dropped.
      pairingEpoch: () => pairingStore.getPairingEpoch(),
      protoStore: operatorProtoStore,
      sessionManager: operatorSessionManager,
      backend: operatorBackend,
      // 016 (review HIGH): the confirm CALL uses proto.jwt; jwtHolder keeps the
      // new operator's JWT (operator-identity); envelopeHolder gets the sale-sync envelope.
      jwtHolder: operatorJwtHolder,
      envelopeHolder: operatorEnvelopeHolder,
      auditEmitter,
      pairingStore,
      deviceTokenAttestation,
      // RT-113 P2 — the cashier takeover is an admission with takeover:true.
      cashierAdmission,
      sessionAdmission,
      logger: mainLogger,
    });

    const operatorPinManagementHandler = new PinManagementHandler({
      db: db,
      safeStorage,
      sessionManager: operatorSessionManager,
      pairingStore,
      auditEmitter,
      // 019 — roster source for the provision path; resolves the
      // target_cashier_id (roster id) → the cashier's roster entry (neutral user_id).
      backend: operatorBackend,
      // RT-214 — the roster is operator-identity + manager gated: present the
      // signed-in manager's JWT from the same holder sign-out/stuck-shifts use.
      jwtHolder: operatorJwtHolder,
      // RT-358 — a session ended by the fail-closed path loses its envelope too.
      clearEnvelope: (sessionId) => {
        operatorEnvelopeHolder.clear(sessionId);
      },
      logger: mainLogger,
    });

    // 004-operator-session dev bypass — seeds a fixture manager session so
    // the renderer routes past /sign-in in unpackaged dev builds.
    // SECURITY: the shipped-app guard is inside applyDevSkipOperatorSignInIfRequested;
    // this call is a no-op in the shipped app (renamed exe included, RT-165)
    // regardless of env vars.
    // Independent from POS_PULSE_DEV_SKIP_PAIRING; both may be set together.
    applyDevSkipOperatorSignInIfRequested({
      isPackaged: shippedApp,
      env: process.env,
      sessionManager: operatorSessionManager,
      logger: mainLogger,
    });

    registerOperatorHandlers(guardedIpcMain, {
      signInHandler: operatorSignInHandler,
      cashierSignInHandler: operatorCashierSignInHandler,
      signOutHandler: operatorSignOutHandler,
      rosterHandler: operatorRosterHandler,
      sessionManager: operatorSessionManager,
      inactivityMonitor: operatorInactivityMonitor,
      auditEmitter,
      pairingStore,
      takeoverHandler: operatorTakeoverHandler,
      pinManagementHandler: operatorPinManagementHandler,
      forcedCloseHandler: new ForcedCloseHandler({
        db: db,
        sessionManager: operatorSessionManager,
        pairingStore,
        auditEmitter,
        // RT-554 (b): a manager's forced close of THIS terminal's shift, from the
        // cash-up tables, with the manager's count; queued as a manager-envelope
        // row and sent by the shift sync engine (see `onDrainNow` below).
        shiftCashup: composeShiftCashupService({
          db,
          isEnabled: () => parseFeatureFlags(process.env).shiftCashup,
          getSession: () =>
            resolveSessionScope(
              operatorSessionManager.getCurrent(),
              pairingStore.getCurrentTerminalId(),
            ),
          isSessionLocked: () => operatorSessionManager.getCurrent()?.lock_state === 'locked',
          pairedScope: async () => pairedShiftScope(await pairingStore.getStatus()),
          pairingEpoch: () => pairingStore.getPairingEpoch(),
          managerPins,
          now: () => new Date().toISOString(),
        }),
        deliverNow: () =>
          shiftSyncDrainNowRef.current === null
            ? Promise.resolve(false)
            : shiftSyncDrainNowRef.current(),
        // RT-772: a manager's forced close is a safe-point trigger for an update install, but
        // only after its delivery has finished: the install quits the app.
        onCloseDelivered: () => {
          updateService.notifyShiftClosed();
        },
      }),
      stuckShiftsHandler: new StuckShiftsHandler({
        sessionManager: operatorSessionManager,
        backendClient: operatorBackend,
        jwtHolder: operatorJwtHolder,
        // RT-358 — a session ended by the fail-closed path loses its envelope too.
        clearEnvelope: (sessionId) => {
          operatorEnvelopeHolder.clear(sessionId);
        },
        logger: mainLogger,
      }),
    });

    // 009-product-search-and-barcode-lookup S4 (T043) — the production R7
    // resolver. 005 left `cart.resolveItemRef` unwired (refusing stub); 009
    // wires a real read-model-backed resolver behind the SAME §A1 seam. It
    // re-reads name/price authoritatively from the catalogue (the renderer
    // supplies only `{ item_ref }`), tenant-scoped to the live session (P17).
    // The dev fixture still wins in an unpackaged build with the fixture flag
    // set (see wire-cart-handlers.ts precedence); this is the production path.
    const catalogueResolver = createCatalogueResolver({
      repo: createProductRepo(db),
      // `linesAdd` gates `no_session` before the resolver runs, so a null
      // session never reaches here; coalesce defensively so the closure's
      // `string` return is total and never throws.
      getTenantId: () => operatorSessionManager.getCurrent()?.tenant_id ?? '',
    });

    // 006-payments-tender Slice 3 (T142 + F-002/F-003/F-004) — wire the
    // payments.* + tender.* bridge surface. The 8 handler factories share
    // the three S3a repositories, both FSMs, and a single idempotency
    // helper + audit-emitter pair.
    const paymentsAttemptsRepo = bindPaymentAttemptsRepository(db);
    const paymentsLinesRepo = bindPaymentTenderLinesRepository(db);
    const paymentsOutboxRepo = bindPaymentActionOutboxRepository(db);

    const paymentAttemptFsm = createPaymentAttemptFsm({
      db: db,
      attempts: paymentsAttemptsRepo,
      lines: paymentsLinesRepo,
      outbox: paymentsOutboxRepo,
    });
    const tenderLineFsm = createTenderLineFsm({
      db: db,
      attempts: paymentsAttemptsRepo,
      lines: paymentsLinesRepo,
      outbox: paymentsOutboxRepo,
    });

    const paymentsIdempotency = createIdempotencyHelper({ outbox: paymentsOutboxRepo });

    // Adapter — the payments and sales emitters write their own event shapes;
    // both forward to 004's `audit_events` table via the shared
    // `AuditEventsStore.insertIgnore` with the same field mapping. F-006:
    // 004's `ActionCategory` union does not yet include the 7 payment
    // categories at the TypeScript level (migration 0017 extends the SQL
    // CHECK only). The cast lives at this single seam and is bounded by the
    // migration's CHECK; a future PR by 004's owner should extend
    // `AUDIT_ACTION_CATEGORIES`.
    const forwardAuditEvent = (evt: PaymentAuditEvent | SaleAuditEvent): void => {
      auditEventsStore.insertIgnore({
        event_id: randomUUID(),
        tenant_id: evt.tenant_id,
        branch_id: evt.branch_id,
        originating_terminal_id: evt.originating_terminal_id,
        acting_operator_id: evt.attribution_operator_id,
        session_id: evt.session_id,
        shift_id: null,
        action_category: evt.action_category as unknown as Audit004ActionCategory,
        created_at: evt.created_at,
        approving_supervisor_id: null,
        payload: evt.payload,
      });
    };
    const paymentAuditEmitter = createPaymentAuditEmitter({
      sink: { write: forwardAuditEvent },
    });
    // RT-496 — heals (or holds for manual review) settled attempts stranded
    // without their `payment.settled` audit. Run at startup before the
    // finalize listener, and on a same-key `payments.confirm` replay.
    const settledAuditReconciler = createSettledAuditReconciler({
      db,
      linesRepo: paymentsLinesRepo,
      auditEmitter: paymentAuditEmitter,
      now: () => new Date().toISOString(),
    });

    // RT-26 — Checkout Back: the payments record decides whether a handed-off
    // cart may return to the Sale (no tender, no settled / force-failed payment)
    // and cancels a zero-funds started attempt inside the cart transaction.
    const releaseCheckoutPayment = bindCheckoutReturnGuard({
      db,
      paymentAttemptFsm,
      auditEmitter: paymentAuditEmitter,
    });

    // 005-sales-cart S2 — register `cart:*` IPC with DB-backed CartStore.
    const cartBridgeHandlers = createCartBridgeHandlers({
      dbHandle: db,
      getCurrentSession: () => operatorSessionManager.getCurrent(),
      // #380 (F-007) — stamp cart rows with the real terminal_id, not branch_id.
      getTerminalId: () => pairingStore.getCurrentTerminalId(),
      logger: mainLogger,
      auditEmitter,
      isPackaged: shippedApp,
      productionResolver: catalogueResolver,
      // Post-handoff cancel and the snapshot "paid" flag read the payments record.
      cartPaymentStatus: bindCartPaymentStatus(db),
      releaseCheckoutPayment,
      // RT-26 — read-only twin for Checkout's Back eligibility (no writes).
      checkoutReturnAllowed: bindCheckoutReturnAllowed(db),
      // RT-443 — a cashier's post-handoff cancel consumes a manager approval.
      approvals: managerApprovals,
    });
    registerCartHandlers(guardedIpcMain, { handlers: cartBridgeHandlers });

    // RT-440 (PK-2, spec 024) — Park v1: `cart:park` / `listParked` /
    // `previewResume` / `resume`. Local only, offline; resume re-prices from
    // the local catalogue read model. `cart:` channels, so the lock, recovery
    // and sale-boundary guards cover them.
    registerCartParkHandlers(guardedIpcMain, {
      parkResume: createParkResume({
        db,
        store: bindParkStore(db),
        cartStore: bindCartStore(db),
        getCurrentSession: () => operatorSessionManager.getCurrent(),
        getTerminalId: () => pairingStore.getCurrentTerminalId(),
        auditEmitter,
        prices: createCataloguePriceLookup(createProductRepo(db)),
        logger: mainLogger,
      }),
    });

    const deviceReadDownDeps = {
      guardedIpcMain,
      db,
      pairingStore,
      pairedWorkersLatch,
      operatorSessionManager,
      workerRegistry,
      mainLogger,
      backendFetch,
      deviceAuthDetector,
      readSendableDeviceToken,
    };
    const { bootPairing } = await registerCatalogue(deviceReadDownDeps);
    registerBranding(deviceReadDownDeps);

    const paymentsSessionAdapter = (): OperatorSessionForPayments | null =>
      // #380 (F-007 FIXED) — stamp the REAL terminal_id from the pairing store,
      // NOT session.branch_id (the retired shortcut that collapsed every
      // terminal at a branch into one payment scope so one stuck attempt
      // bricked them all). resolveSessionScope is the extracted, unit-tested
      // seam shared with the sales adapter; returns null on no-session OR
      // unpaired. display_name flows through for 008 T094b's settled audit.
      resolveSessionScope(operatorSessionManager.getCurrent(), pairingStore.getCurrentTerminalId());

    const paymentsClock = (): Date => new Date();
    const paymentsUuid = (): string => randomUUID();

    // Shared dependency bundles for the payments/tender handler factories —
    // each factory destructures only the keys it declares.
    const paymentsReadDeps = {
      getCurrentSession: paymentsSessionAdapter,
      attemptsRepo: paymentsAttemptsRepo,
      linesRepo: paymentsLinesRepo,
    };
    const paymentsWriteDeps = {
      ...paymentsReadDeps,
      idempotency: paymentsIdempotency,
      auditEmitter: paymentAuditEmitter,
      clock: paymentsClock,
      cashShiftGate: bindCashShiftGate(db), // RT-998: cash needs an open shift (apply + settle)
    };

    const paymentsStart = createPaymentsStartHandler({
      ...paymentsWriteDeps,
      paymentAttemptFsm,
      uuid: paymentsUuid,
      // §A4: main decides if the cart may be paid (handed off, in scope, matches, unpaid).
      checkCartForPayment: bindCartPaymentEligibility(db),
      // §A4: never discard another cart's attempt while it holds tender.
      attemptHasLiveTender: bindAttemptHasLiveTender(db),
    });
    // RT-496 — the settle and its `payment.settled` audit commit in one
    // transaction (the audit sink writes to this same `db`, synchronously);
    // the reconciler heals or holds settlements stranded before that fix.
    const paymentsSettleDeps = {
      settlement: createSettlementCommitter({
        db,
        paymentAttemptFsm,
        attemptsRepo: paymentsAttemptsRepo,
        auditEmitter: paymentAuditEmitter,
      }),
      settledAuditReconciler,
    };
    const paymentsConfirm = createPaymentsConfirmHandler({
      ...paymentsWriteDeps,
      ...paymentsSettleDeps,
      paymentAttemptFsm,
    });
    const paymentsCancel = createPaymentsCancelHandler({
      ...paymentsWriteDeps,
      paymentAttemptFsm,
    });
    const paymentsSubscribe = createPaymentsSubscribeHandler(paymentsReadDeps);
    const paymentsRead = createPaymentsReadHandler(paymentsReadDeps);
    // RT-700 (P-26-1) — card refused in main while the flag is off; read per call.
    const isCardTenderEnabled = (): boolean => parseFeatureFlags(process.env).cardTender;
    const tenderApply = createTenderApplyHandler({
      ...paymentsWriteDeps,
      tenderLineFsm,
      uuid: paymentsUuid,
      logger: mainLogger,
      isCardTenderEnabled,
    });
    const tenderReverse = createTenderReverseHandler({
      ...paymentsWriteDeps,
      tenderLineFsm,
    });
    const tenderRead = createTenderReadHandler(paymentsReadDeps);
    const paymentsForceFail = createPaymentsForceFailHandler({
      ...paymentsWriteDeps,
      paymentAttemptFsm,
      // RT-441 — restricted: an attempt holding live tender goes to recovery.
      attemptHasLiveTender: bindAttemptHasLiveTender(db),
    });

    registerPaymentsHandlers(guardedIpcMain, {
      paymentsStart,
      paymentsConfirm,
      paymentsCancel,
      paymentsSubscribe,
      paymentsRead,
      tenderApply,
      tenderReverse,
      tenderRead,
      paymentsForceFail,
    });

    // RT-441 (RT-116 S6, §5) — manager recovery. Its payment calls run the
    // same handlers under a recovery-scoped session (the stuck attempt's own
    // session id), set only for the duration of one call after the approval
    // is consumed; normal calls keep their own session gate.
    const managerRecovery = createManagerRecovery({
      db,
      getSession: () => operatorSessionManager.getCurrent(),
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
      approvals: managerApprovals,
      cartStore: bindCartStore(db),
      payments: createRecoveryPaymentPort((getCurrentSession) => {
        const scoped = { ...paymentsWriteDeps, getCurrentSession };
        return {
          apply: createTenderApplyHandler({
            ...scoped,
            tenderLineFsm,
            uuid: paymentsUuid,
            logger: mainLogger,
            isCardTenderEnabled,
          }),
          confirm: createPaymentsConfirmHandler({
            ...scoped,
            ...paymentsSettleDeps,
            paymentAttemptFsm,
          }),
          cancel: createPaymentsCancelHandler({ ...scoped, paymentAttemptFsm }),
        };
      }),
      auditEmitter,
      endRecoverySession: () => operatorSignOutHandler.signOut(),
      logger: mainLogger,
    });
    recoveryRef.current = managerRecovery;
    registerRecoveryHandlers(guardedIpcMain, { recovery: managerRecovery, logger: mainLogger });

    // RT-442 (RT-116 S5, §9) — the #380 session-end / sign-in reversal sweep
    // is retired: no session end ever reverses tender. A zero-funds attempt is
    // closed and a live-tender attempt is held for its owner by the held-cart
    // lifecycle (`payments/held-attempts.ts`); nothing runs at boot (§6).

    // 006 T271 — deferred-reversal resolver bootstrap.
    //
    // The resolver scans `payment_tender_lines` for `reversal_pending`
    // voucher lines and retries `vouchers.reverse` against V-A. It runs
    // on (a) app start, (b) future 003 network-restore signal, (c)
    // explicit cashier retry (no bridge surface yet).
    //
    // **Production wiring (PR #222 fixup — CR-1).** The V-A reverse
    // client is wired here using the same `apiBaseUrl` + `fetch` seam
    // the operator backend already uses. The resolver supplies the
    // per-line `idempotencyKey` (derived from `tender_line_id`); the
    // closure bakes in baseUrl / fetch / logger.
    //
    // The 003 network-restore signal is still TBD (no network module
    // yet); the resolver runs without it via (a) app-start and (c)
    // the manual-retry entry point.
    const reverseVoucherForResolver = async (
      input: ReverseVoucherInput,
      options: { idempotencyKey: string },
    ): Promise<ReverseVoucherOutcome> => {
      return await reverseVoucher(input, {
        baseUrl: apiBaseUrl,
        fetch: backendFetch,
        logger: {
          info: (payload, msg): void => {
            mainLogger.info(payload, msg);
          },
          warn: (payload, msg): void => {
            mainLogger.warn(payload, msg);
          },
          error: (payload, msg): void => {
            mainLogger.error(payload, msg);
          },
        },
        idempotencyKey: options.idempotencyKey,
      });
    };
    const deferredReversalResolver = createDeferredReversalResolver({
      linesRepo: paymentsLinesRepo,
      attemptsRepo: paymentsAttemptsRepo,
      tenderLineFsm,
      auditEmitter: paymentAuditEmitter,
      reverseVoucher: reverseVoucherForResolver,
      logger: {
        info: (payload, msg): void => {
          mainLogger.info(payload, msg);
        },
        warn: (payload, msg): void => {
          mainLogger.warn(payload, msg);
        },
        error: (payload, msg): void => {
          mainLogger.error(payload, msg);
        },
      },
      clock: paymentsClock,
    });
    void deferredReversalResolver.start().catch((err: unknown) => {
      mainLogger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'deferred_reversal_resolver:start_failed',
      );
    });

    // ── Shared receipt printer + drawer ports (RT-15 S4: hoisted out of the
    // 008 branch below so the return payout reuses the same instances) ──────
    //
    // 008 §A3 print transports.
    //
    // OS-print path (T200): the REAL `webContents.print` transport is wired —
    // an actual 008 receipt prints through the Windows OS print path on a
    // physically attached printer (e.g. the BIXOLON SRP-330 II from the §A5
    // bench). The slip is rendered to 80 mm continuous-roll width to match the
    // recorded browser/HTML render-quality smoke. `getPrintersAsync` enumerates
    // the system printers; an unconfigured `deviceName` targets the system
    // default. (Mapping a SPECIFIC queue to the paired terminal is a follow-up:
    // pairing/T094a carries USB vendor/product/com-port ids, NOT the Windows
    // print-queue name.) Verified on the bench by T301; the pure parts are
    // unit-tested in os-print-transport.test.ts.
    //
    // ESC/POS-direct path: still an honest STUB reporting `offline` — that path
    // (node-thermal-printer ↔ printer status byte) remains unverified (a5
    // findings) and is NOT selected. We route to OS-print via
    // `probeEscposSupport: false`, the proven path.
    // RT-886 (RT-839 S1): the operator's receipt printer choice (migration 0057).
    // The OS-print transport reads it on EVERY print, so a change applies without
    // a restart and covers the sale receipt, the return slip and every reprint
    // (they share this one pipeline). No choice, or «Windows default», leaves the
    // device name unset (the Windows default printer). A chosen printer that is
    // not installed fails the print loudly; it never prints elsewhere.
    const printerSettingRepo = bindPrinterSettingRepository(db);
    const chosenPrinterName = (): string | undefined => {
      const choice = printerSettingRepo.get();
      return choice?.source === 'chosen' ? choice.printer_name : undefined;
    };
    // RT-772: every print (receipt, cash return slip, sale-history reprint) is counted here, so an
    // update never installs mid-print.
    const printPipeline = trackPrintPipeline(
      createPrintPipeline({
        escposAdapter: createEscposAdapter({
          transport: {
            write: () => Promise.resolve(),
            pollStatus: () => Promise.resolve('offline' as const),
          },
          statusTimeoutMs: 3000,
        }),
        osPrintAdapter: createOsPrintAdapter({
          // RT-847: a printer driver that opens its own window takes the
          // foreground; give the cashier window its activation back once the
          // print is over (never while a print is still in flight).
          // RT-886: the transport resolves the chosen printer per print, inside
          // the wrapper, so the test page and every receipt get the same refocus.
          print: withPrintRefocus(
            createOsPrintTransport({
              createPrintWindow: createDefaultPrintWindow,
              listPrinters: () => getCurrentPrinters(),
              resolveDeviceName: chosenPrinterName,
              logger: mainLogger,
            }),
            { getWindow: () => mainWindow, logger: mainLogger },
          ),
        }),
        // Route to the OS-print path: it is the proven transport (the ESC/POS
        // direct path is unverified). The cashier never sees which path ran
        // unless the print fails (path is for audit only — T212).
        probeEscposSupport: () => Promise.resolve(false),
      }),
      printActivity,
    );
    // 008 Slice 4 drawer port, hoisted (RT-15 S4) so the sale drawer-kick
    // dispatcher and the return payout share ONE drawer transport. The real
    // DK1/DK2 transport is the §A3 hardware bring-up (T200), deferred: until
    // then this honest STUB reports `no_drawer_configured`. RT-531 (owner
    // decision 2026-10-15): the cash drawer is optional, and that answer means
    // "this terminal has no drawer" — a cash sale records a `suppressed` drawer
    // row (no notice) and a return payout completes as `no_drawer` (no manual
    // attestation). Never a faked "opened" (PRODUCT.md Principle 3). A real
    // transport that answers `printer_dk_failure` / `os_error` / `timeout` is a
    // configured drawer that failed: it still warns and keeps the attestation.
    const drawerKickTransport: DrawerKickTransport = {
      kick: () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' }),
    };

    // RT-886 — `printer.*`: list the installed printers, read / save the choice,
    // send a test page. Any signed-in role (owner decision, RT-839 comment
    // 13968); the service checks for a live, unlocked session on every call and
    // audits each change and test page. Registered whatever the feature flags,
    // like the print pipeline itself.
    registerPrinterHandlers(guardedIpcMain, {
      service: createPrinterService({
        getSession: () => {
          const scope = resolveSessionScope(
            operatorSessionManager.getCurrent(),
            pairingStore.getCurrentTerminalId(),
          );
          return scope === null
            ? null
            : {
                operator_id: scope.operator_id,
                operator_session_id: scope.operator_session_id,
                tenant_id: scope.tenant_id,
                branch_id: scope.branch_id,
                terminal_id: scope.terminal_id,
              };
        },
        isSessionLocked: () => operatorSessionManager.getCurrent()?.lock_state === 'locked',
        repo: printerSettingRepo,
        listPrinters: () => getCurrentPrinters(),
        printer: printPipeline,
        audit: auditEmitter,
        transaction: (fn) => {
          db.transaction(fn)();
        },
        now: () => new Date().toISOString(),
        newEventId: () => randomUUID(),
        logger: mainLogger,
      }),
      logger: mainLogger,
    });

    // ── 008-sale-finalization-and-receipts Slice 1c.3 (T094c) ──────────────
    //
    // Wire the AD-2 finalize worker + read-only `sales.*` bridge behind the
    // `sale_finalization` feature flag (fail-closed default off). When the
    // flag is off no Sale rows are written. RT-162 / D-1: that is only a valid
    // profile with payments OFF too — PAYMENTS on + SALE_FINALIZATION off is
    // refused at startup (see runbook 008 T525).
    //
    // The worker is terminal-scoped: it only fires for the paired terminal.
    // We read the scope from the pairing status; an unpaired terminal cannot
    // reach a POS surface at all (the renderer is walled at /pairing), so a
    // non-paired status here means "nothing to finalize" and we skip start.
    if (getAppConfig().features?.saleFinalization === true) {
      // RT-893 extraction 6a — the read-only `sales.*` + `receipts.*` bridges and the sale-history
      // handlers (see `bootstrap/sales-bridges.ts`). Registered whenever the flag is on, NOT gated
      // on pairing: pairing happens in-renderer with no relaunch (T094c).
      const { salesRepo, saleAuditEmitter, printDispatcher, drawerKickDispatcher } =
        registerSalesBridges({
          guardedIpcMain,
          db,
          backendFetch,
          operatorSessionManager,
          operatorEnvelopeHolder,
          pairingStore,
          secretStore,
          deviceTokenKey: DEVICE_TOKEN_KEY,
          forwardAuditEvent,
          printPipeline,
          chosenPrinterName,
          drawerKickTransport,
          mainLogger,
        });

      // The AD-2 finalize WORKER, by contrast, IS terminal-scoped and only
      // starts for a paired terminal — it needs the pairing row's scope to
      // filter the scan. RT-202: a terminal that pairs mid-process starts the
      // worker (and the sale-sync engine) right after the pairing is persisted,
      // through the same starter a paired boot runs immediately — never only on
      // the next launch. The startup recovery scan below runs on either path.
      pairedWorkersLatch.register('finalize listener + sale-sync engine', (pairingStatus) => {
        // RT-893 extraction 6b — the AD-2 finalize listener: finalize transaction, first print,
        // settlement reconcile, startup recovery and the tick (see `bootstrap/finalize.ts`).
        startFinalizeListener(
          {
            db,
            salesRepo,
            saleAuditEmitter,
            printDispatcher,
            drawerKickDispatcher,
            settledAuditReconciler,
            workerRegistry,
            mainLogger,
          },
          pairingStatus,
        );

        // RT-900 extraction 6c — the 011 sale-sync engine: capture client, rollout gates, engine,
        // status handler, terminal-status sync axis and drain interval (see `bootstrap/sale-sync.ts`).
        startSaleSyncEngine(
          {
            guardedIpcMain,
            db,
            salesRepo,
            backendFetch,
            operatorSessionManager,
            operatorEnvelopeHolder,
            pairingStore,
            secretStore,
            deviceTokenKey: DEVICE_TOKEN_KEY,
            deviceAuthDetector,
            terminalStatusPublisher,
            workerRegistry,
            mainLogger,
          },
          pairingStatus,
        );
      });
      if (bootPairing.kind !== 'paired') {
        // Boot-time fact only: the starter above runs when the pairing completes.
        mainLogger.info('finalize_listener:skipped_unpaired');
      }
    }

    // RT-530 — the manager-approved sale void: `saleVoid:*` IPC and the flag-gated background send
    // (RT-893 extraction 5; see `bootstrap/sale-void.ts`).
    registerSaleVoid({
      guardedIpcMain,
      db,
      backendFetch,
      operatorSessionManager,
      operatorEnvelopeHolder,
      pairingStore,
      managerApprovals,
      auditEmitter,
      forwardAuditEvent,
      workerRegistry,
      mainLogger,
      saleVoidRef,
    });

    // RT-15 S2 — cashier returns: `returns:*` IPC and the flag-gated background resolver
    // (RT-893 extraction 5; see `bootstrap/returns.ts`).
    registerReturns({
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
    });

    // RT-17 slice 3 + slice 4 — the shift cash-up sync engine and IPC (RT-893 extraction 4);
    // both flag-gated, default off (see `bootstrap/shift.ts`).
    registerShift({
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
    });

    // RT-772: after the last IPC registration, so a download that completes at once
    // already sees the real shift, cart, payment, return and print state.
    startUpdater({ updateService });

    createWindow();
    mainLogger.info('app:ready');
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err: unknown) => {
    // R3 + R4: any failure here (logger init, migrations, or
    // SecretStore production refusal) halts launch. We deliberately
    // keep `console.error` here rather than the logger because the
    // logger itself may have failed to initialize.
    console.error('[pos-pulse] fatal startup error:', err);
    closeDbHandle();
    app.exit(1);
  });

function closeDbHandle(): void {
  // 008 (T094c) / 021 S1 — stop the AD-2 finalize worker, 010 read-down driver,
  // and 011 sale-sync interval BEFORE closing the DB so a mid-flight background
  // tick cannot run against a closed handle. Stop ordering, failure isolation,
  // and idempotency are owned by the worker registry; this function preserves
  // the sequencing (drain, then close).
  pairedWorkers?.close();
  updateServiceHandle?.stop();
  workerRegistry.stopAll();
  dbHolder.close();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    closeDbHandle();
    app.quit();
  }
});

// Defensive cleanup on quit for the macOS path (no-op on Windows but
// keeps invariants symmetric: handle never outlives the app process).
app.on('quit', () => {
  closeDbHandle();
});
