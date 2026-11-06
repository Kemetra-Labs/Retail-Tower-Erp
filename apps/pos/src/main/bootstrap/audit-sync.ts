/**
 * RT-1231 — wires the audit upload for the paired terminal: the RT-160 D-2
 * privileged audit events go to Backend-Core `POST /api/pos/v1/audit-events`;
 * every other category is marked local-only and never sent.
 *
 * Started by `startSaleSyncEngine` (the paired-only sync lifecycle) and stopped
 * by its own worker stop, before the DB handle closes. It reads `audit_events`
 * and writes only `audit_events_sync_state`: the local audit write path, the
 * sale outbox and offline operation are untouched.
 *
 * Diagnostics: the main log gets one line per event refused for good or parked
 * (`event_id`, category and closed reason only; P7), one line per undelivered
 * batch (closed reason and status only) and the counts of each flush that did
 * work. Never a payload, a token or a response body.
 */
import type { Logger } from 'pino';
import type { PairedTerminal } from '../app/paired-workers.js';
import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import { AuditSync, type AuditSettleReason } from '../audit/audit-sync.js';
import { createAuditSyncClient } from '../audit/audit-sync-client.js';
import { bindAuditSyncStoreDb } from '../audit/audit-sync-store.js';
import {
  AUDIT_SYNC_BACKOFF_POLICY,
  AUDIT_SYNC_INTERVAL_MS,
  scheduleAuditSync,
} from '../audit/schedule-audit-sync.js';
import type { DatabaseHandle } from '../db/client.js';
import type { FetchLike } from '../http/transport.js';
import {
  createSendableDeviceTokenReader,
  type SendableDeviceTokenReaderDeps,
} from '../pairing/device-token.js';
import type { PairingStore } from '../pairing/store.js';
import { resolveApiBaseUrl } from './env.js';

export interface AuditSyncDeps {
  readonly db: DatabaseHandle;
  /** The shared `backendFetch` (request id, build identity, status observer). */
  readonly backendFetch: FetchLike;
  /** The sendable device-token read: null unless paired, null once revoked (RT-215). */
  readonly readDeviceToken: () => Promise<string | null>;
  /** The live terminal id of the current pairing (RT-221 scope). */
  readonly currentTerminalId: () => string | null;
  readonly workerRegistry: Pick<WorkerRegistry, 'register'>;
  readonly mainLogger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Test seam; defaults to `resolveApiBaseUrl()`. */
  readonly baseUrl?: string;
}

/** What the sale-sync bootstrap already holds, from which the audit upload is wired. */
export interface AuditSyncSourceDeps {
  readonly db: DatabaseHandle;
  readonly backendFetch: FetchLike;
  readonly pairingStore: SendableDeviceTokenReaderDeps['pairingStore'] &
    Pick<PairingStore, 'getCurrentTerminalId'>;
  readonly secretStore: SendableDeviceTokenReaderDeps['secretStore'];
  readonly deviceTokenKey: SendableDeviceTokenReaderDeps['deviceTokenKey'];
  readonly workerRegistry: Pick<WorkerRegistry, 'register'>;
  readonly mainLogger: AuditSyncDeps['mainLogger'];
}

/**
 * The audit upload's deps: the never-reject sendable device-token reader (null
 * unless paired, null once revoked) and the live terminal id of the pairing.
 */
export function auditSyncDepsOf(source: AuditSyncSourceDeps): AuditSyncDeps {
  const { pairingStore, secretStore, deviceTokenKey } = source;
  return {
    db: source.db,
    backendFetch: source.backendFetch,
    readDeviceToken: createSendableDeviceTokenReader({ pairingStore, secretStore, deviceTokenKey }),
    currentTerminalId: () => pairingStore.getCurrentTerminalId(),
    workerRegistry: source.workerRegistry,
    mainLogger: source.mainLogger,
  };
}

function logSettled(
  logger: AuditSyncDeps['mainLogger'],
  event: { event_id: string; action_category: string },
  reason: AuditSettleReason,
): void {
  logger.warn(
    { event_id: event.event_id, action_category: event.action_category, ...reason },
    reason.kind === 'parked' ? 'audit_sync:event_parked' : 'audit_sync:event_refused_final',
  );
}

export function startAuditSync(deps: AuditSyncDeps, pairing: PairedTerminal): void {
  const { mainLogger } = deps;
  let stopped = false;

  const store = bindAuditSyncStoreDb(deps.db, () => {
    const terminalId = deps.currentTerminalId();
    return terminalId === null
      ? null
      : { tenantId: pairing.tenant_id, branchId: pairing.branch_id, terminalId };
  });
  const client = createAuditSyncClient({
    baseUrl: deps.baseUrl ?? resolveApiBaseUrl(),
    fetch: deps.backendFetch,
    readDeviceToken: deps.readDeviceToken,
    onUndelivered: (info) => {
      mainLogger.warn(info, 'audit_sync:batch_undelivered');
    },
  });
  const sync = new AuditSync({
    store,
    client,
    isStopped: () => stopped,
    observer: {
      onEventSettled: (event, reason) => {
        logSettled(mainLogger, event, reason);
      },
    },
  });

  const stop = scheduleAuditSync({
    flush: async () => {
      const outcome = await sync.flush();
      if (outcome.kind === 'progress' || outcome.kind === 'retry') {
        mainLogger.info({ ...outcome.counts, outcome: outcome.kind }, 'audit_sync:flushed');
      }
      return outcome;
    },
    latchStopped: () => {
      stopped = true;
    },
    intervalMs: AUDIT_SYNC_INTERVAL_MS,
    backoff: AUDIT_SYNC_BACKOFF_POLICY,
    logger: mainLogger,
  });
  deps.workerRegistry.register('audit-sync interval', stop);
  mainLogger.info({ terminal_id: pairing.terminal_id }, 'audit_sync:started');
}
