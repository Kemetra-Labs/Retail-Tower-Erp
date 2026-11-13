import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ recordCaptureCutoverOnce: vi.fn() }));

vi.mock('../../sales-sync/capture-cutover.js', () => ({
  recordCaptureCutoverOnce: m.recordCaptureCutoverOnce,
}));

import { recordCaptureCutoverAtBoot, type CaptureCutoverBootDeps } from '../capture-cutover.js';

/**
 * RT-1379 — the boot step that records the tender and receipt capture instant once, right after
 * the migrations and before the paired-workers latch starts the finalize listener. `index.ts`
 * cannot be imported under vitest, so the step is pinned here; the decision and the write are
 * covered in `sales-sync/__tests__/capture-cutover*.test.ts`.
 */
function harness(): {
  deps: CaptureCutoverBootDeps;
  logger: Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
} {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    db: { marker: 'db' },
    env: { POS_PULSE_FEATURE_SALE_TENDERS_SINCE: '2026-10-01T00:00:00Z' },
    mainLogger: logger,
  } as unknown as CaptureCutoverBootDeps;
  return { deps, logger };
}

describe('recordCaptureCutoverAtBoot (RT-1379)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records once on the open handle with the process environment, the wall clock and the main logger', () => {
    const h = harness();
    recordCaptureCutoverAtBoot(h.deps);
    expect(m.recordCaptureCutoverOnce).toHaveBeenCalledTimes(1);
    const call = m.recordCaptureCutoverOnce.mock.calls[0]?.[0] as {
      db: unknown;
      env: unknown;
      now: () => Date;
      logger: unknown;
    };
    expect(call.db).toBe(h.deps.db);
    expect(call.env).toBe(h.deps.env);
    expect(call.logger).toBe(h.logger);
    const before = Date.now();
    const now = call.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('never throws: a failed write logs a closed-set code only, and the sale sync later runs with both off', () => {
    const h = harness();
    m.recordCaptureCutoverOnce.mockImplementationOnce(() => {
      throw Object.assign(new Error('disk I/O error at C:\\Users\\cashier\\pos-pulse.db'), {
        code: 'SQLITE_IOERR',
      });
    });
    expect(() => {
      recordCaptureCutoverAtBoot(h.deps);
    }).not.toThrow();
    expect(h.logger.error).toHaveBeenCalledWith(
      { code: 'SQLITE_IOERR' },
      'sale_sync:capture_cutover_unrecorded',
    );
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain('cashier');
  });

  it('a failure without a machine code logs no code', () => {
    const h = harness();
    m.recordCaptureCutoverOnce.mockImplementationOnce(() => {
      throw new Error('anything');
    });
    recordCaptureCutoverAtBoot(h.deps);
    expect(h.logger.error).toHaveBeenCalledWith(
      { code: undefined },
      'sale_sync:capture_cutover_unrecorded',
    );
  });
});
