/**
 * RT-1312 Phase 3(c) — wires the sale-quarantine uploader: the till uploads each
 * sale it dead-lettered on a non-retryable 4xx, and each sale held after a re-pair,
 * to Backend-Core `posQuarantineSale` so the Console can repair it (owner decision
 * D1). Started by `registerDeviceHeartbeat` inside the heartbeat's paired-only
 * callback, because the gate lives there: the uploader reads the heartbeat's last
 * `pos_contract_revision` and stays inert below
 * `QUARANTINE_UPLOAD_MIN_REVISION` (see `quarantine-upload/quarantine-upload-drain.ts`).
 *
 * One pass at a time on the audit-sync loop (`scheduleAuditSync`: every 60 s,
 * bounded exponential backoff while the server is unreachable or answering a
 * retryable status). Each sale is rebuilt the way the capture drain builds it, with
 * its own cashier route (resolved for the sale's own terminal, so an earlier
 * pairing's sale is attributed) and the same RT-79 / RT-540 cutoffs.
 *
 * Nothing here touches a sale, the outbox, a receipt or the capture sync, and
 * nothing reaches the cashier. Logs carry the opaque sale id, a status and a
 * closed-set reason: never the body or the token. The stop (a worker stop, run
 * synchronously before the DB handle closes) clears the timer and latches stopped,
 * so a request in flight writes nothing on the closing DB.
 */
import type { Logger } from 'pino';
import { AUDIT_SYNC_BACKOFF_POLICY, scheduleAuditSync } from '../audit/schedule-audit-sync.js';
import type { DatabaseHandle } from '../db/client.js';
import type { FetchLike } from '../http/transport.js';
import type { PairingStore } from '../pairing/store.js';
import {
  createQuarantineUploadClient,
  type QuarantineUploadClient,
} from '../quarantine-upload/quarantine-upload-client.js';
import {
  createQuarantineUploader,
  type QuarantineDrainOutcome,
  type QuarantineUploadStore,
} from '../quarantine-upload/quarantine-upload-drain.js';
import { readEngineCutoffs } from '../sales-sync/capture-cutover.js';
import { readTenderRefsSince } from '../sales-sync/tender-refs-cutoff.js';
import { saleHasLineDiscount } from '../sales-sync/discount-hold.js';
import { NO_RESOLVED_ROLES, readResolvedRoles } from '../sales-sync/discount-role-resolutions.js';
import {
  createSellingUserIdResolver,
  type SellingUserIdResolver,
} from '../sales-sync/selling-user-id.js';
import { bindSalesRepository } from '../sales/repositories/sales.repository.js';
import { resolveApiBaseUrl } from './env.js';

/**
 * One pass a minute, at most `QUARANTINE_UPLOAD_BATCH_LIMIT` requests each. The upload
 * has its own per-device write bucket on Backend-Core (decision P6); a 429 is retried
 * after its `Retry-After`, so a large backlog is paced by the server, not by this number.
 */
const QUARANTINE_UPLOAD_INTERVAL_MS = 60_000;

interface SaleQuarantineUploadDeps {
  readonly db: DatabaseHandle;
  readonly store: QuarantineUploadStore;
  /** The shared `backendFetch` (request id, build identity, status observer). */
  readonly backendFetch: FetchLike;
  /** `readSendableDeviceToken`: null unless paired and not revoked. */
  readonly readSendableDeviceToken: () => Promise<string | null>;
  readonly pairingStore: Pick<PairingStore, 'getCurrentTerminalId'>;
  readonly mainLogger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Test seam: the upload client. Defaults to the real one on `backendFetch`. */
  readonly client?: QuarantineUploadClient;
  /** Test seam: the cashier resolver. Defaults to the real one on `db`. */
  readonly sellingUsers?: SellingUserIdResolver;
}

/**
 * Starts the uploader for the paired terminal; returns its stop. `readRevision` is
 * the heartbeat's last `pos_contract_revision` (null before any reply).
 */
export function startSaleQuarantineUpload(
  deps: SaleQuarantineUploadDeps,
  terminal: { readonly tenant_id: string; readonly branch_id: string },
  readRevision: () => number | null,
): () => void {
  const { db, mainLogger } = deps;
  let stopped = false;
  const salesRepo = bindSalesRepository(db);
  // The same cutoffs the capture drain builds with (RT-363 included), so a quarantine body
  // equals the body the drain sent; the capture bootstrap already warned about a bad value.
  const cutoffs = {
    ...readEngineCutoffs(db, mainLogger),
    tenderRefsSince: readTenderRefsSince(process.env, { warn: () => undefined }),
  };
  const sellingUsers =
    deps.sellingUsers ??
    createSellingUserIdResolver({
      db,
      onUnresolved: ({ saleId, reason }) => {
        mainLogger.warn({ sale_id: saleId, reason }, 'quarantine_upload:selling_user_unresolved');
      },
      onLookupFailed: () => {
        mainLogger.warn({}, 'quarantine_upload:selling_user_lookup_failed');
      },
    });

  const uploader = createQuarantineUploader({
    store: deps.store,
    client:
      deps.client ??
      createQuarantineUploadClient({ baseUrl: resolveApiBaseUrl(), fetch: deps.backendFetch }),
    scope: () => {
      const terminalId = deps.pairingStore.getCurrentTerminalId();
      return terminalId === null
        ? null
        : { tenantId: terminal.tenant_id, branchId: terminal.branch_id, terminalId };
    },
    readToken: deps.readSendableDeviceToken,
    readRevision,
    loadSale: (saleId) => salesRepo.readById(saleId),
    // The route is resolved for the sale's OWN terminal: an earlier pairing's sale
    // would otherwise be held as `terminal_mismatch`.
    routeOf: (sale) =>
      sellingUsers.resolve([sale], sale.terminal_id).get(sale.sale_id) ?? { kind: 'hold' },
    rolesOf: (sale) =>
      saleHasLineDiscount(sale) ? readResolvedRoles(db, sale.sale_id) : NO_RESOLVED_ROLES,
    cutoffs,
    now: () => new Date(),
    isStopped: () => stopped,
    backoff: AUDIT_SYNC_BACKOFF_POLICY,
    onSettled: (saleId) => {
      sellingUsers.forget(saleId);
    },
    onUploaded: (saleId, status) => {
      mainLogger.info({ sale_id: saleId, status }, 'quarantine_upload:uploaded');
    },
    onRefused: (saleId, status) => {
      mainLogger.warn({ sale_id: saleId, status }, 'quarantine_upload:refused');
    },
    onSkipped: (saleId, reason) => {
      mainLogger.warn({ sale_id: saleId, reason }, 'quarantine_upload:skipped');
    },
  });

  const flush = async (): Promise<QuarantineDrainOutcome> => {
    try {
      return await uploader.drain();
    } catch (err: unknown) {
      mainLogger.error({ err }, 'quarantine_upload:drain_unexpected');
      return { kind: 'undelivered' };
    }
  };

  const stop = scheduleAuditSync({
    flush,
    latchStopped: () => {
      stopped = true;
    },
    intervalMs: QUARANTINE_UPLOAD_INTERVAL_MS,
    backoff: AUDIT_SYNC_BACKOFF_POLICY,
    logger: mainLogger,
  });
  mainLogger.info({}, 'quarantine_upload:started');
  return stop;
}
