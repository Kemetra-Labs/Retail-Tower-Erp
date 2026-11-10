/**
 * RT-1312 Phase 1 (P1-D1) — when the till sends its device heartbeat.
 *
 *   - once at start (the bootstrap starts it when the terminal is paired), then
 *     every {@link HEARTBEAT_INTERVAL_MS} after the last beat (the contract cadence);
 *   - soon after the sale-queue counts change: they are polled every
 *     {@link HEARTBEAT_POLL_MS}, and a change from what the last stored beat
 *     reported asks for a beat;
 *   - on {@link HeartbeatScheduler.requestBeat} (the bootstrap calls it on every
 *     update state change, the other contract trigger);
 *   - never two requests less than {@link HEARTBEAT_MIN_GAP_MS} apart: Backend-Core
 *     stores at most one beat per device per 60 s, so a closer one is not stored.
 *     A change during the cool-down is sent the moment it ends.
 *
 * `sale_queue` is sent only after a reply carried `pos_contract_revision` >= 2
 * (kept in memory with its receive time). The first beat after a start therefore
 * has none, and the gate opening asks for the next beat at once, so the counts
 * reach the Console one cool-down after start rather than 15 minutes later.
 *
 * Failures (decided rules):
 *   - 400: the body was refused and nothing stored. The cached revision is
 *     dropped (a Backend-Core that went back to an older build refuses the
 *     `sale_queue` key), so the following beats omit it until a reply says 2 again.
 *     No faster retry.
 *   - 401: no faster retry: change and update-state requests are ignored until a
 *     reply accepts the credential again; the 15-minute beat still runs.
 *   - 5xx, an unreadable reply, a timeout or a network fault: an unsent count
 *     change stays unsent, so the next poll asks again (still 61 s apart).
 * Nothing here touches a sale, the sync, a shift or a sign-in, and nothing throws.
 * The log line carries the outcome and the HTTP status only.
 */
import type { HeartbeatClient, HeartbeatOutcome } from './heartbeat-client.js';
import {
  SALE_QUEUE_MIN_REVISION,
  buildHeartbeatBody,
  saleQueueKey,
  type HeartbeatFacts,
  type SaleQueueCounts,
} from './heartbeat-wire.js';

export const HEARTBEAT_INTERVAL_MS = 15 * 60_000;
export const HEARTBEAT_POLL_MS = 30_000;
/** One second over Backend-Core's 60 s storage throttle. */
export const HEARTBEAT_MIN_GAP_MS = 61_000;

interface HeartbeatLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

export interface HeartbeatSchedulerDeps {
  /** `readSendableDeviceToken`: null unless paired and not revoked (then nothing is sent). */
  readonly readToken: () => Promise<string | null>;
  /** Everything but the queue, read at beat time. */
  readonly readFacts: () => Omit<HeartbeatFacts, 'saleQueue'>;
  /** The till's sale-queue counts (a local read); null or a throw = unknown. */
  readonly readSaleQueue: () => SaleQueueCounts | null;
  readonly client: Pick<HeartbeatClient, 'report'>;
  readonly logger: HeartbeatLogger;
  readonly now?: () => number;
}

export interface HeartbeatScheduler {
  /** The first beat and the timers. Idempotent. */
  start(): void;
  /** A beat as soon as the cool-down allows (ignored after a 401, until a reply accepts again). */
  requestBeat(): void;
  /** Clears every timer; a reply still in flight changes nothing afterwards. Idempotent. */
  stop(): void;
}

type Timer = ReturnType<typeof setTimeout>;

function unref(timer: Timer): Timer {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

const OUTCOME_LOG = 'device_heartbeat:reported';

export function createHeartbeatScheduler(deps: HeartbeatSchedulerDeps): HeartbeatScheduler {
  const now = deps.now ?? Date.now;
  let started = false;
  let stopped = false;
  let inFlight = false;
  let pending = false;
  let authRefused = false;
  let lastAttemptAt: number | null = null;
  let revision: number | null = null;
  let reportedQueueKey: string | null = null;
  let intervalTimer: Timer | undefined;
  let deferTimer: Timer | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  // Read through functions: an await can change them, which flow narrowing cannot see.
  const isStopped = (): boolean => stopped;
  const hasPending = (): boolean => pending;
  const gateOpen = (): boolean => revision !== null && revision >= SALE_QUEUE_MIN_REVISION;

  function readQueue(): SaleQueueCounts | null {
    try {
      return deps.readSaleQueue();
    } catch {
      return null;
    }
  }

  function apply(outcome: HeartbeatOutcome, sentQueue: boolean, queue: SaleQueueCounts | null) {
    if (outcome.kind === 'acked') {
      const wasOpen = gateOpen();
      revision = outcome.posContractRevision;
      authRefused = false;
      if (sentQueue && queue !== null) reportedQueueKey = saleQueueKey(queue);
      if (!wasOpen && gateOpen()) pending = true;
    } else if (outcome.kind === 'rejected') {
      revision = null;
      reportedQueueKey = null;
      authRefused = false;
    } else if (outcome.kind === 'unauthorized') {
      authRefused = true;
    }
  }

  function log(outcome: HeartbeatOutcome): void {
    const fields =
      'status' in outcome
        ? { outcome: outcome.kind, status: outcome.status }
        : { outcome: outcome.kind };
    if (outcome.kind === 'acked') deps.logger.info(fields, OUTCOME_LOG);
    else deps.logger.warn(fields, OUTCOME_LOG);
  }

  async function send(): Promise<void> {
    const token = await deps.readToken();
    if (stopped) return;
    if (token === null || token === '') {
      deps.logger.info({ outcome: 'no_credential' }, OUTCOME_LOG);
      return;
    }
    const includeSaleQueue = gateOpen();
    const queue = includeSaleQueue ? readQueue() : null;
    const body = buildHeartbeatBody(
      { ...deps.readFacts(), saleQueue: queue },
      { includeSaleQueue },
    );
    lastAttemptAt = now();
    const outcome = await deps.client.report(token, body);
    if (isStopped()) return;
    apply(outcome, includeSaleQueue, queue);
    log(outcome);
  }

  async function beat(): Promise<void> {
    if (stopped) return;
    if (inFlight) {
      pending = true;
      return;
    }
    clearTimeout(deferTimer);
    deferTimer = undefined;
    clearTimeout(intervalTimer);
    inFlight = true;
    pending = false;
    try {
      await send();
    } catch {
      deps.logger.warn({ outcome: 'failed' }, OUTCOME_LOG);
    } finally {
      inFlight = false;
    }
    if (isStopped()) return;
    intervalTimer = unref(setTimeout(() => void beat(), HEARTBEAT_INTERVAL_MS));
    if (hasPending()) requestBeat();
  }

  function requestBeat(): void {
    if (stopped || authRefused) return;
    if (inFlight) {
      pending = true;
      return;
    }
    const wait = lastAttemptAt === null ? 0 : lastAttemptAt + HEARTBEAT_MIN_GAP_MS - now();
    if (wait <= 0) {
      void beat();
      return;
    }
    pending = true;
    deferTimer ??= unref(
      setTimeout(() => {
        deferTimer = undefined;
        void beat();
      }, wait),
    );
  }

  function poll(): void {
    if (stopped || inFlight || !gateOpen()) return;
    const queue = readQueue();
    if (queue !== null && saleQueueKey(queue) !== reportedQueueKey) requestBeat();
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      pollTimer = unref(setInterval(poll, HEARTBEAT_POLL_MS));
      void beat();
    },
    requestBeat,
    stop() {
      stopped = true;
      clearTimeout(intervalTimer);
      clearTimeout(deferTimer);
      clearInterval(pollTimer);
    },
  };
}
