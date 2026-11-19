/**
 * RT-1312 Phase 3(c) — one pass of the quarantine uploader: the till sends each
 * sale it dead-lettered on a non-retryable 4xx, and each sale held after a
 * re-pair, to Backend-Core `posQuarantineSale`, so the Console can repair it.
 *
 * INERT until Backend-Core advertises the upload (c16621). A till stops counting
 * a row in the heartbeat once it is uploaded (decision P4), so nothing may go
 * before the Console can show the queue. The gate is the heartbeat's own
 * revision ack: {@link QuarantineUploaderDeps.readRevision} is the last
 * `pos_contract_revision` a reply carried (the heartbeat scheduler's
 * `lastAck()`), read live on every pass, and a pass below
 * {@link QUARANTINE_UPLOAD_MIN_REVISION} (or with no reply yet, which is the
 * first moments after a start, or after a 400 cleared the ack) reads no store,
 * no token and sends nothing. The revision bump itself is Backend-Core's
 * (RT-1312 Phase 3(b) slice B), set only once the Console shows the queue.
 *
 * A pass, in order: stopped / not advertised / unpaired / no device token →
 * idle. Then the stranded sales, oldest first; each one is rebuilt
 * (`buildQuarantineUpload`), sent, and:
 *   uploaded (200 / 201)      → marked uploaded: the till keeps its local row,
 *                               stops counting it and never uploads it again
 *   refused (400 / 409 / 413) → marked refused: not retried automatically; the
 *                               heartbeat counts keep showing it
 *   retry (401 / 404 / 429 / 5xx) → the row is charged (attempts + 1) and due
 *                               again after the backoff, or the `Retry-After`
 *                               when longer; the pass stops, so a failing
 *                               server gets one request per pass
 *   unreachable               → the pass stops and the row is untouched
 * A sale with no sendable body (decision P1) or an unprovable cashier is
 * skipped: no request, no mark, and it does not use up the batch. Each such
 * sale is reported once. A stop latched while a request is in flight writes
 * nothing more (the DB handle may be closing), as the sale sync (RT-198).
 *
 * Nothing here touches a sale, the outbox, a receipt or the capture sync.
 * Diagnostics carry the opaque sale id, the status and a closed-set reason:
 * never the body (it holds money and the receipt operator name) or the token.
 */
import { backoffDelay, type AuditSyncBackoffPolicy } from '../audit/schedule-audit-sync.js';
import type { BuildCapturePayloadOptions } from '../sales-sync/capture-payload.js';
import type { ResolvedDiscountRoles } from '../sales-sync/discount-role-resolutions.js';
import type { SaleRoute } from '../sales-sync/selling-user-id.js';
import type { SaleRow } from '../sales/repositories/sales.repository.js';
import {
  buildQuarantineUpload,
  type QuarantineSkipReason,
  type QuarantineSource,
} from './quarantine-upload-body.js';
import type {
  QuarantineReceipt,
  QuarantineUploadBody,
  QuarantineUploadClient,
  QuarantineUploadOutcome,
} from './quarantine-upload-client.js';

/**
 * The first `pos_contract_revision` that includes `posQuarantineSale` for a till:
 * the one after 2, which added `sale_queue` to the heartbeat. Backend-Core's
 * slice B bumps to exactly this value once the Console shows the queue; no
 * other POS-facing change may take revision 3 before that.
 */
export const QUARANTINE_UPLOAD_MIN_REVISION = 3;

/** Requests sent per pass; the rest wait for the next pass (the bucket is per device). */
const QUARANTINE_UPLOAD_BATCH_LIMIT = 10;

/** How long a sale with no sendable body waits before it is looked at again. */
const QUARANTINE_PARK_MS = 60 * 60_000;

/** The current pairing's scope; only this tenant and branch are uploaded (decision P2). */
export interface QuarantineScope {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
}

/** One stranded sale that is due for an upload. */
export interface QuarantineCandidate {
  readonly saleId: string;
  readonly source: QuarantineSource;
  /** Attempts so far (0 for a sale never tried). */
  readonly attempts: number;
}

export interface QuarantineUploadStore {
  /** The scope's stranded sales due now (never uploaded, or pending and due), oldest first. */
  listCandidates(scope: QuarantineScope, nowIso: string): QuarantineCandidate[];
  markUploaded(
    saleId: string,
    scope: QuarantineScope,
    status: number,
    receipt: QuarantineReceipt | null,
    atIso: string,
  ): void;
  markRefused(saleId: string, scope: QuarantineScope, status: number, atIso: string): void;
  /**
   * A stranded sale with no sendable body: due again at `nextAttemptAtIso`, with no
   * attempt charged and no status, so a branch full of them is not rebuilt every pass.
   */
  markParked(saleId: string, scope: QuarantineScope, nextAttemptAtIso: string, atIso: string): void;
  /** One more attempt; due again at `nextAttemptAtIso`. */
  markRetry(
    saleId: string,
    scope: QuarantineScope,
    status: number | null,
    nextAttemptAtIso: string,
    atIso: string,
  ): void;
}

export type QuarantineDrainOutcome = {
  readonly kind: 'idle' | 'progress' | 'retry' | 'undelivered';
};

export interface QuarantineUploaderDeps {
  readonly store: QuarantineUploadStore;
  readonly client: QuarantineUploadClient;
  /** The current pairing's scope, or null when unpaired. */
  readonly scope: () => QuarantineScope | null;
  /** The sendable device token (null unless paired and not revoked). */
  readonly readToken: () => Promise<string | null>;
  /** The last `pos_contract_revision` a heartbeat reply carried; null when none. Read live. */
  readonly readRevision: () => number | null;
  /** The durable sale; null when unreadable. */
  readonly loadSale: (saleId: string) => SaleRow | null;
  /** The sale's own route: its cashier (device), the envelope, or hold. */
  readonly routeOf: (sale: SaleRow) => SaleRoute;
  readonly rolesOf: (sale: SaleRow) => ResolvedDiscountRoles;
  /** The cutoffs the capture drain builds with (the rebuilt body must match it). */
  readonly cutoffs: Pick<BuildCapturePayloadOptions, 'tendersSince' | 'receiptSince'>;
  readonly now: () => Date;
  readonly isStopped: () => boolean;
  readonly backoff: AuditSyncBackoffPolicy;
  readonly batchLimit?: number;
  /** Test seam; defaults to {@link QUARANTINE_UPLOAD_MIN_REVISION}. */
  readonly minRevision?: number;
  /** A sale left the upload queue (uploaded or refused): drop what is memoized for it. */
  readonly onSettled?: (saleId: string) => void;
  readonly onUploaded?: (saleId: string, status: number) => void;
  readonly onRefused?: (saleId: string, status: number) => void;
  /** A stranded sale that cannot be uploaded; once per sale. Opaque id and closed-set reason. */
  readonly onSkipped?: (saleId: string, reason: QuarantineSkipReason | 'unreadable') => void;
}

interface QuarantineUploader {
  drain(): Promise<QuarantineDrainOutcome>;
}

export function createQuarantineUploader(deps: QuarantineUploaderDeps): QuarantineUploader {
  const skipsReported = new Set<string>();
  const minRevision = deps.minRevision ?? QUARANTINE_UPLOAD_MIN_REVISION;
  const batchLimit = deps.batchLimit ?? QUARANTINE_UPLOAD_BATCH_LIMIT;

  function advertised(): boolean {
    const revision = deps.readRevision();
    return revision !== null && revision >= minRevision;
  }

  function reportSkip(saleId: string, reason: QuarantineSkipReason | 'unreadable'): void {
    if (skipsReported.has(saleId)) return;
    skipsReported.add(saleId);
    deps.onSkipped?.(saleId, reason);
  }

  /** A sale that cannot be sent: reported once, and parked so it is not rebuilt every pass. */
  function skip(
    candidate: QuarantineCandidate,
    scope: QuarantineScope,
    nowIso: string,
    reason: QuarantineSkipReason | 'unreadable',
  ): null {
    reportSkip(candidate.saleId, reason);
    const next = new Date(Date.parse(nowIso) + QUARANTINE_PARK_MS).toISOString();
    deps.store.markParked(candidate.saleId, scope, next, nowIso);
    deps.onSettled?.(candidate.saleId);
    return null;
  }

  /** The upload body of one candidate, or null (skipped and parked) when it cannot be sent. */
  function buildFor(
    candidate: QuarantineCandidate,
    scope: QuarantineScope,
    nowIso: string,
  ): QuarantineUploadBody | null {
    const sale = deps.loadSale(candidate.saleId);
    if (sale === null) return skip(candidate, scope, nowIso, 'unreadable');
    const built = buildQuarantineUpload({
      sale,
      source: candidate.source,
      route: deps.routeOf(sale),
      currentTerminalId: scope.terminalId,
      cutoffs: deps.cutoffs,
      resolvedRoles: deps.rolesOf(sale),
      now: nowIso,
    });
    return built.kind === 'skip' ? skip(candidate, scope, nowIso, built.reason) : built.upload;
  }

  /** Persist one answer. Returns the pass's outcome when it must stop, else null. */
  function settle(
    candidate: QuarantineCandidate,
    scope: QuarantineScope,
    outcome: QuarantineUploadOutcome,
  ): QuarantineDrainOutcome | null {
    const stamp = deps.now().toISOString();
    const { saleId } = candidate;
    switch (outcome.kind) {
      case 'unreachable':
        return { kind: 'undelivered' };
      case 'uploaded':
        deps.store.markUploaded(saleId, scope, outcome.status, outcome.receipt, stamp);
        deps.onSettled?.(saleId);
        deps.onUploaded?.(saleId, outcome.status);
        return null;
      case 'refused':
        deps.store.markRefused(saleId, scope, outcome.status, stamp);
        deps.onSettled?.(saleId);
        deps.onRefused?.(saleId, outcome.status);
        return null;
      case 'retry': {
        const delay = Math.max(
          backoffDelay(deps.backoff, candidate.attempts + 1),
          outcome.retryAfterMs ?? 0,
        );
        const next = new Date(Date.parse(stamp) + delay).toISOString();
        deps.store.markRetry(saleId, scope, outcome.status, next, stamp);
        return { kind: 'retry' };
      }
    }
  }

  /** The pass's credentials, or null when it must stay idle (see {@link drain}). */
  async function admit(): Promise<{ scope: QuarantineScope; token: string } | null> {
    const before = deps.scope();
    if (deps.isStopped() || !advertised() || before === null) return null;
    const token = await deps.readToken();
    if (token === null || token === '' || deps.isStopped()) return null;
    // A re-pair completing during the token read could leave the token of one pairing
    // and the candidates classified for another (`previousTerminalId`): send nothing,
    // the next pass starts over.
    const scope = deps.scope();
    return scope === null || scope.terminalId !== before.terminalId ? null : { scope, token };
  }

  async function drain(): Promise<QuarantineDrainOutcome> {
    const admitted = await admit();
    if (admitted === null) return { kind: 'idle' };
    const { scope, token } = admitted;

    const nowIso = deps.now().toISOString();
    let sent = 0;
    for (const candidate of deps.store.listCandidates(scope, nowIso)) {
      // A re-pair since the pass began: nothing more under an identity the candidates
      // were not classified for (the next pass lists them again).
      if (sent >= batchLimit || deps.isStopped() || deps.scope()?.terminalId !== scope.terminalId) {
        break;
      }
      const upload = buildFor(candidate, scope, nowIso);
      if (upload === null) continue;
      const outcome = await deps.client.upload(token, upload);
      sent += 1;
      // Stopped while the request was in flight: write nothing (the DB may be closing).
      if (deps.isStopped()) break;
      const stop = settle(candidate, scope, outcome);
      if (stop !== null) return stop;
    }
    return { kind: sent === 0 ? 'idle' : 'progress' };
  }

  return { drain };
}
