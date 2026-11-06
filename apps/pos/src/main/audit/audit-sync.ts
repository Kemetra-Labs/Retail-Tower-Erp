/**
 * T047 / RT-1231 — Audit sync (outbox → Backend-Core `POST /api/pos/v1/audit-events`).
 *
 * `AuditSync.flush()` reads one page of unsettled audit events from the local
 * store and settles each one:
 *
 *   not a central category → marked local-only, never sent (RT-160 D-2;
 *                            `central-audit-categories.ts`)
 *   off-contract locally   → marked final, never sent: the server would refuse
 *                            the WHOLE batch with 400 (`audit-event-wire.ts`)
 *   accepted[]             → marked synced (the backend persisted the row)
 *   duplicates[]           → marked synced (the backend already has the row)
 *   rejected schema_violation → marked final, never retried: the contract
 *                            documents it as non-retryable (RT-1230)
 *   rejected otherwise, or unaccounted for → left in the outbox and retried,
 *                            at most `maxEventAttempts` times in this process;
 *                            then parked (skipped) until the next start
 *   batch not delivered    → nothing written; the caller backs off
 *                            (`schedule-audit-sync.ts`)
 *   batch refused (400)    → the whole request was refused for one bad event:
 *                            the next batch is halved until the event goes
 *                            alone, where its refusals count toward
 *                            `maxEventAttempts` and it is parked like any
 *                            other retryable event, so it cannot block later
 *                            uploads
 *
 * "Settled without upload" (local-only or final) is a sync-state row with a
 * NULL `synced_at`; the category tells the two apart. No schema change: the
 * table (0004) already allows it. Malformed responses fail safe: nothing is
 * marked synced and the batch is retried.
 *
 * Offline never blocks on this: the local audit write path does not touch it,
 * and every failure leaves events in the outbox for a later flush.
 */

import type { AuditEvent } from '../../shared/audit/event-shape.js';
import { isCentralAuditCategory } from './central-audit-categories.js';
import { isWireReady } from './audit-event-wire.js';

// ─── Rejection categories (contract `RejectedEvent`) ───────────────────────

export type AuditRejectionCategory = 'invalid_input' | 'tenant_mismatch' | 'schema_violation';

export interface AuditRejectedEvent {
  event_id: string;
  category: AuditRejectionCategory;
}

/** The only rejection the contract documents as non-retryable (RT-1230). */
const FINAL_REJECTION: AuditRejectionCategory = 'schema_violation';

// ─── Backend response envelope ─────────────────────────────────────────────

/** The 200 body of `POST /api/pos/v1/audit-events` (`PosAuditEventsSyncResponse`). */
export interface AuditSyncBatchResponse {
  accepted: string[];
  duplicates: string[];
  rejected: AuditRejectedEvent[];
}

// ─── DI interfaces ─────────────────────────────────────────────────────────

export interface AuditEventKey {
  tenant_id: string;
  event_id: string;
}

/** Data-access seam. Production binds better-sqlite3 (`audit-sync-store.ts`). */
export interface AuditSyncStore {
  /**
   * Up to `limit` events with no sync-state row, oldest first, skipping
   * `excludeEventIds` (the events parked in this process).
   */
  listUnsynced(limit: number, excludeEventIds?: readonly string[]): AuditEvent[];

  /** Record that `(tenant_id, event_id)` reached the backend at `synced_at`. */
  markSynced(tenant_id: string, event_id: string, synced_at: string): void;

  /**
   * Settle events WITHOUT uploading them (local-only or a final refusal): a
   * sync-state row with a NULL `synced_at`, in one transaction.
   */
  markSettled(keys: readonly AuditEventKey[]): void;
}

/**
 * HTTP seam. `sendBatch` NEVER throws: it resolves to the parsed 200 body,
 * `'batch_refused'` when Backend-Core refused the request itself (400: one
 * event in it is off-contract), or `'network_error'` when the batch was not
 * delivered (no credential, transport fault, timeout, any other non-200
 * status, unreadable body).
 */
export interface AuditSyncClient {
  sendBatch(
    events: AuditEvent[],
  ): Promise<AuditSyncBatchResponse | 'network_error' | 'batch_refused'>;
}

/** Why an event was settled without upload or parked. Ids and closed codes only (P7). */
export type AuditSettleReason =
  | { kind: 'rejected_final'; category: AuditRejectionCategory }
  | { kind: 'invalid_local' }
  | { kind: 'parked'; attempts: number; category: RetryCategory };

/** Why an event is retried: a per-event rejection, no answer for it, or a 400 alone. */
type RetryCategory = AuditRejectionCategory | 'unaccounted' | 'batch_refused';

export interface AuditSyncObserver {
  /** One event refused for good, or parked: for the main log (diagnostics). */
  onEventSettled?(
    event: Pick<AuditEvent, 'event_id' | 'action_category'>,
    reason: AuditSettleReason,
  ): void;
}

// ─── Options and outcome ───────────────────────────────────────────────────

export interface AuditSyncOptions {
  store: AuditSyncStore;
  client: AuditSyncClient;
  /** Maximum events per page and per POST (contract `maxItems: 100`). Defaults to 100. */
  batchLimit?: number;
  /** Sends of one event that may end in a retryable rejection before it is parked. */
  maxEventAttempts?: number;
  /** Local-only pages settled per flush before giving the event loop back. */
  maxPagesPerFlush?: number;
  /** Shutdown latch: once true, a send in flight writes nothing locally. */
  isStopped?: () => boolean;
  observer?: AuditSyncObserver;
  now?: () => string;
}

/**
 * What one flush did. `undelivered` and `retry` both ask the caller to back
 * off; `progress` and `idle` reset it.
 */
export type AuditFlushOutcome =
  | { kind: 'idle' }
  | { kind: 'undelivered' }
  | { kind: 'progress' | 'retry'; counts: AuditFlushCounts };

export interface AuditFlushCounts {
  synced: number;
  localOnly: number;
  final: number;
  retryable: number;
  parked: number;
}

export interface AuditSyncStatus {
  /** Totals since start; for the diagnostics log line. */
  readonly totals: AuditFlushCounts;
  /** Event ids parked in this process (retried again after a restart). */
  readonly parked: number;
}

const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_MAX_EVENT_ATTEMPTS = 5;
const DEFAULT_MAX_PAGES_PER_FLUSH = 10;

function zeroCounts(): AuditFlushCounts {
  return { synced: 0, localOnly: 0, final: 0, retryable: 0, parked: 0 };
}

function keyOf(event: AuditEvent): AuditEventKey {
  return { tenant_id: event.tenant_id, event_id: event.event_id };
}

// ─── AuditSync ─────────────────────────────────────────────────────────────

export class AuditSync {
  private readonly store: AuditSyncStore;
  private readonly client: AuditSyncClient;
  private readonly batchLimit: number;
  private readonly maxEventAttempts: number;
  private readonly maxPagesPerFlush: number;
  private readonly isStopped: () => boolean;
  private readonly observer: AuditSyncObserver;
  private readonly now: () => string;
  /** event_id → sends that ended in a retryable rejection (this process). */
  private readonly attempts = new Map<string, number>();
  /** Events skipped until the next start. */
  private readonly parked = new Set<string>();
  private readonly totals = zeroCounts();
  /** Events per POST: halved on a 400, doubled back on each answered batch. */
  private sendLimit: number;

  constructor(options: AuditSyncOptions) {
    this.store = options.store;
    this.client = options.client;
    this.batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.sendLimit = this.batchLimit;
    this.maxEventAttempts = options.maxEventAttempts ?? DEFAULT_MAX_EVENT_ATTEMPTS;
    this.maxPagesPerFlush = options.maxPagesPerFlush ?? DEFAULT_MAX_PAGES_PER_FLUSH;
    this.isStopped = options.isStopped ?? (() => false);
    this.observer = options.observer ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
  }

  status(): AuditSyncStatus {
    return { totals: { ...this.totals }, parked: this.parked.size };
  }

  /**
   * Settle local-only pages, then send at most one batch of central events.
   * Never throws for network faults or malformed answers.
   */
  async flush(): Promise<AuditFlushOutcome> {
    const counts = zeroCounts();
    for (let page = 0; page < this.maxPagesPerFlush; page += 1) {
      if (this.isStopped()) break;
      const events = this.store.listUnsynced(this.batchLimit, [...this.parked]);
      if (events.length === 0) break;
      const sendable = this.settleUnsendable(events, counts);
      if (sendable.length > 0) return this.send(sendable.slice(0, this.sendLimit), counts);
    }
    return this.finish(counts);
  }

  /** Marks the local-only and locally invalid events of one page; returns the rest. */
  private settleUnsendable(events: AuditEvent[], counts: AuditFlushCounts): AuditEvent[] {
    const settle: AuditEventKey[] = [];
    const sendable: AuditEvent[] = [];
    for (const event of events) {
      if (!isCentralAuditCategory(event.action_category)) {
        settle.push(keyOf(event));
        counts.localOnly += 1;
      } else if (!isWireReady(event)) {
        settle.push(keyOf(event));
        counts.final += 1;
        this.observer.onEventSettled?.(event, { kind: 'invalid_local' });
      } else {
        sendable.push(event);
      }
    }
    if (settle.length > 0) this.store.markSettled(settle);
    return sendable;
  }

  private async send(events: AuditEvent[], counts: AuditFlushCounts): Promise<AuditFlushOutcome> {
    const result = await this.client.sendBatch(events);
    if (this.isStopped()) return this.finish(counts);
    if (result === 'batch_refused') return this.refused(events, counts);
    if (result === 'network_error' || !isWellFormed(result)) {
      this.add(counts);
      return { kind: 'undelivered' };
    }
    this.sendLimit = Math.min(this.batchLimit, this.sendLimit * 2);
    this.apply(result, events, counts);
    return this.finish(counts);
  }

  /**
   * A 400 for the whole request. Several events: halve the next batch and back
   * off, so the bad event ends up alone. One event: it is the cause, so its
   * refusal counts toward the bound like any retryable rejection.
   */
  private refused(events: AuditEvent[], counts: AuditFlushCounts): AuditFlushOutcome {
    const [only] = events;
    if (events.length > 1 || only === undefined) {
      this.sendLimit = Math.max(1, Math.floor(events.length / 2));
      this.add(counts);
      return { kind: 'undelivered' };
    }
    this.retryLater(only, 'batch_refused', counts);
    return this.finish(counts);
  }

  private apply(
    result: AuditSyncBatchResponse,
    events: AuditEvent[],
    counts: AuditFlushCounts,
  ): void {
    const confirmed = new Set<string>([...result.accepted, ...result.duplicates]);
    const rejections = new Map<string, AuditRejectionCategory>();
    for (const r of Array.isArray(result.rejected) ? result.rejected : []) {
      rejections.set(r.event_id, r.category);
    }
    const syncedAt = this.now();
    const final: AuditEventKey[] = [];
    for (const event of events) {
      const rejection = rejections.get(event.event_id);
      if (confirmed.has(event.event_id)) {
        this.store.markSynced(event.tenant_id, event.event_id, syncedAt);
        this.attempts.delete(event.event_id);
        counts.synced += 1;
      } else if (rejection === FINAL_REJECTION) {
        final.push(keyOf(event));
        this.attempts.delete(event.event_id);
        counts.final += 1;
        this.observer.onEventSettled?.(event, { kind: 'rejected_final', category: rejection });
      } else {
        this.retryLater(event, rejection ?? 'unaccounted', counts);
      }
    }
    if (final.length > 0) this.store.markSettled(final);
  }

  /** A retryable outcome: counted, and parked once it reaches the bound. */
  private retryLater(event: AuditEvent, category: RetryCategory, counts: AuditFlushCounts): void {
    const attempts = (this.attempts.get(event.event_id) ?? 0) + 1;
    if (attempts < this.maxEventAttempts) {
      this.attempts.set(event.event_id, attempts);
      counts.retryable += 1;
      return;
    }
    this.attempts.delete(event.event_id);
    this.parked.add(event.event_id);
    counts.parked += 1;
    this.observer.onEventSettled?.(event, { kind: 'parked', attempts, category });
  }

  private finish(counts: AuditFlushCounts): AuditFlushOutcome {
    this.add(counts);
    const touched =
      counts.synced + counts.localOnly + counts.final + counts.retryable + counts.parked;
    if (touched === 0) return { kind: 'idle' };
    return { kind: counts.retryable > 0 ? 'retry' : 'progress', counts };
  }

  private add(counts: AuditFlushCounts): void {
    this.totals.synced += counts.synced;
    this.totals.localOnly += counts.localOnly;
    this.totals.final += counts.final;
    this.totals.retryable += counts.retryable;
    this.totals.parked += counts.parked;
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/** Fail safe: a 200 body without array `accepted` / `duplicates` marks nothing. */
function isWellFormed(response: AuditSyncBatchResponse | null | undefined): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    Array.isArray(response.accepted) &&
    Array.isArray(response.duplicates)
  );
}
