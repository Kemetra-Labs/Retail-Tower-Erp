/**
 * RT-1231 — the audit upload loop: interval, bounded exponential backoff,
 * reset on progress, and a stop that clears the timer and latches stopped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditFlushOutcome } from '../audit-sync.js';
import {
  AUDIT_SYNC_BACKOFF_POLICY,
  backoffDelay,
  scheduleAuditSync,
} from '../schedule-audit-sync.js';

const PROGRESS: AuditFlushOutcome = {
  kind: 'progress',
  counts: { synced: 1, localOnly: 0, final: 0, retryable: 0, parked: 0 },
};
const RETRY: AuditFlushOutcome = {
  kind: 'retry',
  counts: { synced: 0, localOnly: 0, final: 0, retryable: 1, parked: 0 },
};

describe('RT-1231 backoffDelay', () => {
  it('doubles from the base and caps at the max', () => {
    const policy = { baseMs: 1_000, maxMs: 10_000 };
    expect([1, 2, 3, 4, 5, 6, 100].map((n) => backoffDelay(policy, n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000,
    ]);
  });

  it('the default policy is bounded at 5 minutes', () => {
    expect(backoffDelay(AUDIT_SYNC_BACKOFF_POLICY, 50)).toBe(300_000);
  });
});

describe('RT-1231 scheduleAuditSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function start(outcomes: AuditFlushOutcome[]) {
    const flush = vi.fn(() => Promise.resolve(outcomes.shift() ?? { kind: 'idle' as const }));
    const latchStopped = vi.fn();
    const logger = { error: vi.fn() };
    const stop = scheduleAuditSync({
      flush,
      latchStopped,
      intervalMs: 1_000,
      backoff: { baseMs: 100, maxMs: 400 },
      logger,
    });
    return { flush, latchStopped, logger, stop };
  }

  it('flushes first after one interval, then every interval while idle', async () => {
    const { flush } = start([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(flush).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially (bounded) while undelivered or retrying, and resets on progress', async () => {
    const { flush } = start([
      { kind: 'undelivered' },
      { kind: 'undelivered' },
      RETRY,
      { kind: 'undelivered' },
      PROGRESS,
    ]);
    await vi.advanceTimersByTimeAsync(1_000); // #1 undelivered → 100
    await vi.advanceTimersByTimeAsync(100); // #2 undelivered → 200
    await vi.advanceTimersByTimeAsync(200); // #3 retry → 400
    await vi.advanceTimersByTimeAsync(400); // #4 undelivered → 400 (cap)
    expect(flush).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(399);
    expect(flush).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1); // #5 progress → interval again
    expect(flush).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(999);
    expect(flush).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(6);
  });

  it('logs a flush that throws and backs off, never stopping the loop', async () => {
    const flush = vi
      .fn<() => Promise<AuditFlushOutcome>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ kind: 'idle' });
    const logger = { error: vi.fn() };
    scheduleAuditSync({
      flush,
      latchStopped: vi.fn(),
      intervalMs: 1_000,
      backoff: { baseMs: 100, maxMs: 400 },
      logger,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const [logged, message] = logger.error.mock.calls[0] as [{ err: unknown }, string];
    expect(logged.err).toBeInstanceOf(Error);
    expect(message).toBe('audit_sync:tick_unexpected');
    await vi.advanceTimersByTimeAsync(100);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('stop clears the timer and latches stopped; no flush runs after it', async () => {
    const { flush, latchStopped, stop } = start([]);
    stop();
    expect(latchStopped).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(flush).not.toHaveBeenCalled();
  });

  it('a flush in flight at stop does not re-arm the timer', async () => {
    let release: (o: AuditFlushOutcome) => void = () => undefined;
    const flush = vi.fn(
      () =>
        new Promise<AuditFlushOutcome>((resolve) => {
          release = resolve;
        }),
    );
    const stop = scheduleAuditSync({
      flush,
      latchStopped: vi.fn(),
      intervalMs: 1_000,
      backoff: { baseMs: 100, maxMs: 400 },
      logger: { error: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    stop();
    release({ kind: 'idle' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
