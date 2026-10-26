import type { IpcMain } from 'electron';
import type { Logger } from 'pino';
import type { PairedTerminal } from '../app/paired-workers.js';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import type { DatabaseHandle } from '../db/client.js';
import { registerSalesSyncHandlers } from '../ipc/sales-sync.js';
import type { JwtHolder } from '../operator/jwt-holder.js';
import { createSaleSyncTokenReader } from '../operator/sale-sync-token.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { DeviceAuthDetector } from '../pairing/device-auth-detector.js';
import {
  createSendableDeviceTokenRead,
  type SendableDeviceTokenReaderDeps,
} from '../pairing/device-token.js';
import type { PairingStore } from '../pairing/store.js';
import { parseReceiptSince, parseTendersSince } from '../sales-sync/capture-payload.js';
import {
  CASHIER_CLAIM_REFUSED_RESET_ENV,
  isCashierClaimRefusedResetRequested,
  resetCashierClaimRefusedOnStart,
} from '../sales-sync/cashier-claim-refused-reset.js';
import { composeSaleSyncDevicePath } from '../sales-sync/compose-device-path.js';
import { createSaleSyncClient } from '../sales-sync/create-sale-sync-client.js';
import { createCurrentTerminalResolver } from '../sales-sync/current-terminal.js';
import { SALE_DISCOUNT_CAPTURE_SUPPORTED } from '../sales-sync/discount-hold.js';
import { createSaleSyncStateRepo } from '../sales-sync/sale-sync-state-repo.js';
import {
  createSaleSyncEngine,
  logSaleSyncPauseTransition,
  SALE_SYNC_BACKOFF_POLICY,
} from '../sales-sync/sale-sync-engine.js';
import { createSaleSyncStatusReader } from '../sales-sync/sale-sync-status-reader.js';
import { SALE_SYNC_DRAIN_TIMEOUT_MS, scheduleSaleSync } from '../sales-sync/schedule-sale-sync.js';
import { createTerminalSyncAggregateReader } from '../terminal-status/sync-aggregate.js';
import type { TerminalStatusPublisher } from '../terminal-status/terminal-status-publisher.js';
import { resolveApiBaseUrl } from './env.js';
import type { SalesBridges } from './sales-bridges.js';

/** What `startSaleSyncEngine` closes over from the composition root (RT-900 extraction 6c). */
export interface SaleSyncDeps {
  /** The lock-guarded `ipcMain` the read-only `sales:syncStatus` handler is registered on. */
  guardedIpcMain: IpcMain;
  /** The open database handle the sync state repo uses. */
  db: DatabaseHandle;
  /** The sales repository, reused from the sales bridges (the engine rebuilds each payload from it). */
  salesRepo: SalesBridges['salesRepo'];
  /** The reachability-observed Backend-Core fetch the capture client is built on. */
  backendFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The operator session the sale-sync token reader reads in-process (never bridged). */
  operatorSessionManager: Pick<SessionManager, 'getCurrent'>;
  /** The operator envelope holder the sale-sync token reader reads (RT-016 D5). */
  operatorEnvelopeHolder: Pick<JwtHolder, 'get'>;
  /** The pairing store: the sendable device-token read and the live terminal id / status. */
  pairingStore: SendableDeviceTokenReaderDeps['pairingStore'] &
    Pick<PairingStore, 'getCurrentTerminalId'>;
  /** The secret store the device token is read from (RT-224 device path). */
  secretStore: SendableDeviceTokenReaderDeps['secretStore'];
  /** The secret key the device token is sealed under. */
  deviceTokenKey: SendableDeviceTokenReaderDeps['deviceTokenKey'];
  /** The 2×401 detector the device-path fetch is tagged for (RT-215 × RT-224). */
  deviceAuthDetector: Pick<DeviceAuthDetector, 'observe'>;
  /** The terminal status publisher; its sync axis reads the sale-sync queue (RT-603). */
  terminalStatusPublisher: Pick<TerminalStatusPublisher, 'setSyncReader'>;
  /** Owns the stop callback for the sale-sync interval, run before the DB handle closes. */
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  mainLogger: Logger;
}

/**
 * Wires the live 011 sale-sync engine for the paired terminal: the capture client, the RT-79 tender
 * and RT-540 receipt rollout gates, the RT-225 support reset, the engine, the read-only
 * `sales:syncStatus` handler, the terminal-status sync axis and the 5 s drain interval. `index.ts`
 * calls it as the second step of the paired-only starter it registers on the latch
 * (`pairedWorkersLatch.register('finalize listener + sale-sync engine', …)`), right after
 * `startFinalizeListener`, at the exact position the inline code held.
 */
export function startSaleSyncEngine(deps: SaleSyncDeps, pairingStatus: PairedTerminal): void {
  const {
    guardedIpcMain,
    db,
    salesRepo,
    backendFetch,
    operatorSessionManager,
    operatorEnvelopeHolder,
    pairingStore,
    secretStore,
    deviceTokenKey,
    deviceAuthDetector,
    terminalStatusPublisher,
    workerRegistry,
    mainLogger,
  } = deps;

  // 011 S5 (T061/T062, #349 cleared) — wire the live sale-sync engine. It
  // drains the (008-owned) outbox UP to DP2 captureSale on an interval,
  // authenticating per-POST with the operator session JWT (read in-process;
  // never bridged). The engine pauses when no operator session is present and
  // resumes on the next tick once a session returns. Idempotency, retry/
  // backoff, and dead-letter are owned by the engine + state repo (unchanged);
  // the live client only transforms the payload + maps HTTP outcomes.
  const saleSyncStateRepo = createSaleSyncStateRepo(db);
  // 016 (D5/D7 + review HIGH): the sale-sync POST authenticates with the
  // opaque pos_operator ENVELOPE only (`operatorAuthorization` scheme) — read
  // in-process per POST through the SEPARATE envelope holder. This is the only
  // pair of call sites that read the envelope; sign-out / stuck-shifts / the
  // takeover-confirm CALL all read the JWT holder (`operator-identity`). 016
  // (D7): X-Device-Attestation is retired from the sale wire (#559), so the
  // client takes no getDeviceAttestation dep. The device token keeps its proper
  // roles (read-down Bearer + sign-in attestation body) elsewhere — untouched.
  // RT-224 step 2 (Option B, Backend-Core #709) — device-path sale capture: a
  // sale with its cashier's `selling_user_id` goes out with the device bearer
  // + that id; any other sale keeps the envelope path. Wiring and its tests:
  // `sales-sync/compose-device-path.ts`. RT-215 × RT-224: the token is the
  // sendable read (null unless paired, null once revoked), and the device
  // path gets its own fetch, tagged for the 2×401 detector.
  const saleSyncDevicePath = composeSaleSyncDevicePath({
    db,
    readToken: createSendableDeviceTokenRead({
      pairingStore,
      secretStore,
      deviceTokenKey,
    }),
    currentTerminalId: () => pairingStore.getCurrentTerminalId(),
    deviceAuth: { fetch: backendFetch, detector: deviceAuthDetector },
    logger: mainLogger,
  });
  const saleSyncClient = createSaleSyncClient({
    baseUrl: resolveApiBaseUrl(),
    fetch: backendFetch,
    getOperatorToken: createSaleSyncTokenReader(operatorSessionManager, operatorEnvelopeHolder),
    ...saleSyncDevicePath.client,
    // RT-15 S1: a 200/201 without a usable saleRef — the sale is captured but
    // the till cannot return it. Logs the opaque externalId + a closed-set
    // reason only (never the body or the rejected value; P7).
    onSaleRefUnavailable: ({ externalId, reason }) => {
      mainLogger.warn({ external_id: externalId, reason }, 'sale_sync:sale_ref_unavailable');
    },
  });
  // RT-79 rollout gate: unset = never send tenders (default). Only sales finalized
  // at/after this explicit-zone ISO instant carry `tenders`. Ops MUST choose a
  // FUTURE instant, later than BOTH the Backend-Core tender switch going ON and
  // the restart that loads it here: then no sale at/after the cutoff can have
  // been sent without tenders by an earlier process (its retry body stays
  // identical). A past cutoff re-opens that window. Unparseable = off + warning.
  const tendersSinceRaw = process.env['POS_PULSE_FEATURE_SALE_TENDERS_SINCE'];
  const tendersSince = parseTendersSince(tendersSinceRaw);
  if (tendersSinceRaw !== undefined && tendersSinceRaw.trim() !== '' && tendersSince === null) {
    mainLogger.warn('sale_sync:tenders_since_unparseable_tenders_off');
  }
  // RT-540 rollout gate (same rule as the tenders gate above): unset = never send the
  // `receipt` snapshot (default). Ops MUST choose a FUTURE instant, later than BOTH the
  // Backend-Core RT-539 deploy and the restart that loads it here, so no sale at/after
  // the cutoff can already have been sent without it (a changed body under the same
  // Idempotency-Key is a 409). Unparseable = off + warning.
  const receiptSinceRaw = process.env['POS_PULSE_FEATURE_SALE_RECEIPT_SINCE'];
  const receiptSince = parseReceiptSince(receiptSinceRaw);
  if (receiptSinceRaw !== undefined && receiptSinceRaw.trim() !== '' && receiptSince === null) {
    mainLogger.warn('sale_sync:receipt_since_unparseable_receipt_off');
  }
  // RT-221: the drain (and the pending / held counts) is scoped to the
  // CURRENT pairing's terminal_id, read live from the pairing status each
  // tick. After a re-pair, the earlier pairing's queued sales are held —
  // never replayed under the new device identity (RT-138 L6). Unpaired /
  // invalid → nothing is eligible.
  const resolveSaleSyncTerminalId = createCurrentTerminalResolver(() => pairingStore.getStatus());
  // RT-225 step 3 — support-only repair: with
  // POS_PULSE_SUPPORT_RESET_CASHIER_CLAIM_REFUSED=1, this terminal's sales
  // dead-lettered as `cashier_claim_refused` go back to pending before the
  // drain's first tick, so they are re-sent (with `admissionCheckAt` where it
  // applies). Unset = nothing. Logs a count only (P7); never throws.
  resetCashierClaimRefusedOnStart({
    requested: isCashierClaimRefusedResetRequested(process.env[CASHIER_CLAIM_REFUSED_RESET_ENV]),
    stateRepo: saleSyncStateRepo,
    scope: {
      tenantId: pairingStatus.tenant_id,
      branchId: pairingStatus.branch_id,
      terminalId: pairingStore.getCurrentTerminalId(),
    },
    now: new Date().toISOString(),
    logger: mainLogger,
  });
  // RT-198: the shutdown latch, read by the engine (`isStopped`) and set by the
  // worker stop below, synchronously, before the DB handle closes.
  let saleSyncStopped = false;
  const saleSyncEngine = createSaleSyncEngine({
    client: saleSyncClient,
    tendersSince,
    receiptSince,
    stateRepo: saleSyncStateRepo,
    salesRepo,
    tenantId: pairingStatus.tenant_id,
    branchId: pairingStatus.branch_id,
    resolveTerminalId: resolveSaleSyncTerminalId,
    getOperatorToken: createSaleSyncTokenReader(operatorSessionManager, operatorEnvelopeHolder),
    ...saleSyncDevicePath.engine,
    now: () => new Date().toISOString(),
    // Exponential backoff: 1s base, capped at 5 min.
    backoff: { ...SALE_SYNC_BACKOFF_POLICY },
    onDeadLetter: (saleId: string, reason?: string) => {
      mainLogger.warn({ sale_id: saleId, reason }, 'sale_sync:dead_letter');
    },
    // RT-15 S1: a capture answer's saleRef differed from the stored one; the
    // stored one is kept. Only the opaque externalId is logged (P7).
    onSaleRefMismatch: ({ externalId }) => {
      mainLogger.warn({ external_id: externalId }, 'sale_sync:sale_ref_mismatch');
    },
    // RT-190: a capture 409 — the server holds a different sale for this
    // provenance. Dead-lettered (`payload_divergence`), never retried. Only
    // the opaque externalId + the closed-set error code are logged (P7).
    onPayloadDivergence: ({ externalId, errorCode }) => {
      mainLogger.warn(
        { external_id: externalId, error_code: errorCode },
        'sale_sync:payload_divergence',
      );
    },
    // RT-224: the drain is paused while it holds no sale credential at all, or
    // no envelope while envelope-routed sales are due. Log it once per transition — the
    // closed-set `sale_sync:paused_no_operator_credential` and its resume
    // line — with { reason, pending } only (P7).
    onPauseTransition: (event) => {
      logSaleSyncPauseTransition(mainLogger, event);
    },
    isStopped: () => saleSyncStopped,
    // RT-856: discounted sales are held (pending, never dead-lettered) until
    // RT-858 ships the capture rule and flips this constant. Not an env var.
    discountCaptureSupported: SALE_DISCOUNT_CAPTURE_SUPPORTED,
  });

  // Read-only status surface for the renderer (counts + last-success + the
  // RT-224 closed-set paused reason; no token/PII/raw body crosses the
  // bridge). No write/trigger handler.
  registerSalesSyncHandlers(guardedIpcMain, {
    readStatus: createSaleSyncStatusReader({
      stateRepo: saleSyncStateRepo,
      tenantId: pairingStatus.tenant_id,
      branchId: pairingStatus.branch_id,
      resolveTerminalId: resolveSaleSyncTerminalId,
      pausedReason: () => saleSyncEngine.pausedReason(),
      discountCaptureSupported: SALE_DISCOUNT_CAPTURE_SUPPORTED,
    }),
  });
  // RT-603 — the terminal status sync axis reads the same queue (sales only,
  // D-6-4). The publisher's stop (before the DB closes) unbinds it, so a late
  // `terminalStatus:get` reads the empty axis rather than a closed DB.
  terminalStatusPublisher.setSyncReader(
    createTerminalSyncAggregateReader({
      stateRepo: saleSyncStateRepo,
      tenantId: pairingStatus.tenant_id,
      branchId: pairingStatus.branch_id,
      resolveTerminalId: resolveSaleSyncTerminalId,
      pausedReason: () => saleSyncEngine.pausedReason(),
      // RT-887: held discounted sales are neither "sending" nor ageing.
      discountCaptureSupported: SALE_DISCOUNT_CAPTURE_SUPPORTED,
    }),
  );

  // Background drain on an interval. Single-flight in the engine coalesces
  // overlapping ticks; the interval is cleared and the engine latched stopped
  // on quit (closeDbHandle), so a send in flight writes nothing locally.
  const SALE_SYNC_INTERVAL_MS = 5_000;
  const stopSaleSync = scheduleSaleSync({
    engine: saleSyncEngine,
    latchStopped: () => {
      saleSyncStopped = true;
    },
    intervalMs: SALE_SYNC_INTERVAL_MS,
    drainTimeoutMs: SALE_SYNC_DRAIN_TIMEOUT_MS,
    logger: mainLogger,
  });
  // Synchronous like every worker stop: the latch makes the DB close safe
  // right after; the drain promise is not awaited here.
  workerRegistry.register('sale-sync interval', () => {
    void stopSaleSync();
  });
  mainLogger.info({ terminal_id: pairingStatus.terminal_id }, 'sale_sync_engine:started');
}
