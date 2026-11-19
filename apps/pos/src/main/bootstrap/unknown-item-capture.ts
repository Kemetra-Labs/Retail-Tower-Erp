/**
 * RT-1490 — wires the unknown-item capture: a `not_found` barcode scan is
 * queued in `unknown_item_captures` (migration 0064) and sent to Backend-Core
 * `posCaptureItem` in the background, so the Console review queue hears of it.
 *
 * Two halves:
 *   • the returned hook, given to the catalogue bridge: it defers the enqueue
 *     past the lookup's reply (`setImmediate`), so the scan's answer is never
 *     delayed by the write, and it never throws;
 *   • a paired-only drain on the audit-sync loop (`scheduleAuditSync`: one
 *     drain at a time, every 30 s, bounded exponential backoff while offline
 *     or answered with a retryable status). It sends only with the current
 *     operator's envelope; with no operator signed in the rows wait. Its stop
 *     runs before the DB handle closes.
 *
 * Nothing reaches the cashier: no copy, no state, no sale change. Diagnostics
 * are counts and keys only (a refused row's key and status), never a token.
 */
import type { Logger } from 'pino';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import type { PairedWorkers } from '../app/paired-workers.js';
import { AUDIT_SYNC_BACKOFF_POLICY, scheduleAuditSync } from '../audit/schedule-audit-sync.js';
import type { DatabaseHandle } from '../db/client.js';
import type { FetchLike } from '../http/transport.js';
import type { JwtHolder } from '../operator/jwt-holder.js';
import { createSaleSyncTokenReader } from '../operator/sale-sync-token.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { PairingStore } from '../pairing/store.js';
import { uuidv7 } from '../returns/uuidv7.js';
import { createUnknownItemCaptureClient } from '../unknown-items/capture-client.js';
import {
  drainUnknownItemCaptures,
  type CaptureDrainOutcome,
} from '../unknown-items/capture-drain.js';
import {
  createUnknownBarcodeReporter,
  type UnknownBarcodeReporter,
} from '../unknown-items/capture-reporter.js';
import { bindUnknownItemCaptureStore } from '../unknown-items/capture-store.js';
import { resolveApiBaseUrl } from './env.js';

/** The drain cadence when the queue is healthy. */
export const UNKNOWN_ITEM_CAPTURE_INTERVAL_MS = 30_000;

export interface UnknownItemCaptureDeps {
  readonly db: DatabaseHandle;
  /** The shared `backendFetch` (request id, build identity, status observer). */
  readonly backendFetch: FetchLike;
  readonly pairingStore: Pick<PairingStore, 'getCurrentTerminalId'>;
  readonly pairedWorkersLatch: Pick<PairedWorkers, 'register'>;
  readonly operatorSessionManager: Pick<SessionManager, 'getCurrent'>;
  /** The pos_operator envelope holder (the route's credential, not the device token). */
  readonly operatorEnvelopeHolder: Pick<JwtHolder, 'get'>;
  readonly workerRegistry: Pick<WorkerRegistry, 'register'>;
  readonly mainLogger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Test seam; defaults to `resolveApiBaseUrl()` when the drain starts. */
  readonly baseUrl?: string;
  /** Test seam; defaults to `setImmediate`. */
  readonly defer?: (fn: () => void) => void;
}

function deferImmediate(fn: () => void): void {
  setImmediate(fn);
}

/** Registers the paired-only drain; returns the bridge's `not_found` hook. */
export function registerUnknownItemCapture(deps: UnknownItemCaptureDeps): UnknownBarcodeReporter {
  const { mainLogger, pairingStore } = deps;
  const store = bindUnknownItemCaptureStore(deps.db);

  const report = createUnknownBarcodeReporter({
    store,
    terminalId: () => pairingStore.getCurrentTerminalId(),
    now: () => new Date(),
    mintId: () => uuidv7(),
    onError: (err) => {
      mainLogger.warn({ err }, 'unknown_item_capture:enqueue_failed');
    },
  });

  deps.pairedWorkersLatch.register('unknown-item capture', (terminal) => {
    let stopped = false;
    const client = createUnknownItemCaptureClient({
      baseUrl: deps.baseUrl ?? resolveApiBaseUrl(),
      fetch: deps.backendFetch,
    });
    const getEnvelope = createSaleSyncTokenReader(
      deps.operatorSessionManager,
      deps.operatorEnvelopeHolder,
    );

    const flush = async (): Promise<CaptureDrainOutcome> => {
      try {
        const outcome = await drainUnknownItemCaptures({
          store,
          client,
          scope: () => {
            const terminalId = pairingStore.getCurrentTerminalId();
            return terminalId === null
              ? null
              : { tenantId: terminal.tenant_id, branchId: terminal.branch_id, terminalId };
          },
          getEnvelope,
          now: () => new Date(),
          isStopped: () => stopped,
          backoff: AUDIT_SYNC_BACKOFF_POLICY,
          onRefused: (captureId, status) => {
            mainLogger.warn({ capture_id: captureId, status }, 'unknown_item_capture:refused');
          },
        });
        if (outcome.kind === 'progress' || outcome.kind === 'retry') {
          mainLogger.info({ outcome: outcome.kind }, 'unknown_item_capture:drained');
        }
        return outcome;
      } catch (err: unknown) {
        mainLogger.error({ err }, 'unknown_item_capture:drain_unexpected');
        return { kind: 'undelivered' };
      }
    };

    const stop = scheduleAuditSync({
      flush,
      latchStopped: () => {
        stopped = true;
      },
      intervalMs: UNKNOWN_ITEM_CAPTURE_INTERVAL_MS,
      backoff: AUDIT_SYNC_BACKOFF_POLICY,
      logger: mainLogger,
    });
    deps.workerRegistry.register('unknown-item capture interval', stop);
    mainLogger.info({ terminal_id: terminal.terminal_id }, 'unknown_item_capture:started');
  });

  const defer = deps.defer ?? deferImmediate;
  return (barcode, session) => {
    defer(() => {
      report(barcode, session);
    });
  };
}
