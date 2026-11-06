/**
 * RT-1231 — the audit upload loop: one flush at a time, on a timer, with
 * bounded exponential backoff.
 *
 *   idle / progress → next flush after `intervalMs`; the backoff resets
 *   undelivered / retry → next flush after base × 2^(n-1), capped at `maxMs`
 *
 * Offline therefore costs one cheap attempt per backoff step and loses
 * nothing: the events stay in the outbox and go on the first flush after the
 * connection returns. The loop never blocks a till action: it runs on its own
 * timer and a flush that throws is logged and backed off.
 *
 * The stop (a worker stop, run synchronously before the DB handle closes)
 * clears the timer and latches stopped, so a send in flight writes nothing on
 * the closing DB (as the sale-sync stop, RT-198). The events stay unsettled
 * and are sent again, same ids (idempotent server-side), on the next start.
 */
import type { AuditFlushOutcome } from './audit-sync.js';

export interface AuditSyncBackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
}

/** 5 s, doubling, capped at 5 min (the sale-sync cap). */
export const AUDIT_SYNC_BACKOFF_POLICY: AuditSyncBackoffPolicy = { baseMs: 5_000, maxMs: 300_000 };
export const AUDIT_SYNC_INTERVAL_MS = 15_000;

export interface ScheduleAuditSyncInput {
  readonly flush: () => Promise<AuditFlushOutcome>;
  /** Sets what the sync's `isStopped` reads. Synchronous and idempotent. */
  readonly latchStopped: () => void;
  readonly intervalMs: number;
  readonly backoff: AuditSyncBackoffPolicy;
  readonly logger: { error(obj: Record<string, unknown>, msg: string): void };
  /** Test seams; default to the global timers. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** The delay after `failures` consecutive backed-off flushes (failures ≥ 1). */
export function backoffDelay(policy: AuditSyncBackoffPolicy, failures: number): number {
  const exp = Math.min(failures - 1, 30);
  return Math.min(policy.maxMs, policy.baseMs * 2 ** exp);
}

function backsOff(outcome: AuditFlushOutcome): boolean {
  return outcome.kind === 'undelivered' || outcome.kind === 'retry';
}

/** Start the loop (first flush after one interval). Returns the worker stop. */
export function scheduleAuditSync(input: ScheduleAuditSyncInput): () => void {
  const setTimer =
    input.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      return setTimeout(fn, ms);
    });
  const clearTimer =
    input.clearTimer ??
    ((handle: unknown): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  let stopped = false;
  let failures = 0;
  let timer: unknown = null;

  const arm = (ms: number): void => {
    if (!stopped) timer = setTimer(() => void tick(), ms);
  };

  const tick = async (): Promise<void> => {
    timer = null;
    let outcome: AuditFlushOutcome;
    try {
      outcome = await input.flush();
    } catch (err: unknown) {
      input.logger.error({ err }, 'audit_sync:tick_unexpected');
      outcome = { kind: 'undelivered' };
    }
    failures = backsOff(outcome) ? failures + 1 : 0;
    arm(failures === 0 ? input.intervalMs : backoffDelay(input.backoff, failures));
  };

  arm(input.intervalMs);
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    input.latchStopped();
  };
}
