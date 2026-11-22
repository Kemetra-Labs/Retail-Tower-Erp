/**
 * RT-1553 — the late-commit detector's own rules, over a fake checker (the read itself is proven
 * end to end in `returns-close.test.ts`):
 *   • the sweep reads a closed return only once the quiet period since its close has passed, and an
 *     unreadable close time counts as due;
 *   • a verdict ends the sweep's reads of that return; no verdict and a skip do not;
 *   • `checkSale` reads every closed return of the sale, whatever the quiet period, and says whether
 *     one of them is now a late commit;
 *   • once the domain is stopping nothing is read.
 */
import { describe, expect, it } from 'vitest';

import type { AuthSnapshot } from '../returns-auth.js';
import type { ClosedCheck } from '../returns-close-service.js';
import type { NewDisposition } from '../returns-dispositions-repository.js';
import { createLateCommitDetector } from '../returns-late-commit.js';
import type { JournalEntry } from '../returns-repository.js';

const QUIET = 15 * 60 * 1000;
const CLOSED_AT = '2026-11-23T10:00:00.000Z';
const actor = { scope: { tenantId: 't', branchId: 'b', terminalId: 'term' } } as AuthSnapshot;

const entry = (returnId: string, saleId = 'sale-1'): JournalEntry =>
  ({ returnId, saleId }) as JournalEntry;

function harness(options: {
  rows: JournalEntry[];
  answers?: ClosedCheck[];
  closedAt?: string;
  stopped?: () => boolean;
  throwFor?: string[];
}) {
  const state = {
    now: CLOSED_AT,
    reads: [] as string[],
    saleAsked: [] as (string | undefined)[],
    logged: [] as string[],
  };
  const throwing = new Set(options.throwFor ?? []);
  const answers = [...(options.answers ?? [])];
  const detector = createLateCommitDetector({
    repo: {
      listClosed: (_scope, saleId) => {
        state.saleAsked.push(saleId);
        return options.rows.filter((r) => saleId === undefined || r.saleId === saleId);
      },
    },
    dispositions: {
      listFor: (returnId) =>
        [
          { returnId, kind: 'not_recorded_closed', createdAt: options.closedAt ?? CLOSED_AT },
        ] as NewDisposition[],
    },
    checker: {
      checkClosed: (_actor, e) => {
        state.reads.push(e.returnId);
        if (throwing.has(e.returnId)) return Promise.reject(new Error('local write failed'));
        return Promise.resolve(answers.shift() ?? 'clear');
      },
    },
    now: () => state.now,
    isStopped: options.stopped ?? (() => false),
    logger: { error: (_obj, msg) => state.logged.push(msg) },
  });
  const later = (ms: number): void => {
    state.now = new Date(Date.parse(CLOSED_AT) + ms).toISOString();
  };
  return { detector, state, later };
}

describe('the late-commit sweep', () => {
  it('reads nothing before the quiet period since the close has passed', async () => {
    const { detector, state, later } = harness({ rows: [entry('r1')] });
    later(QUIET - 1);
    await detector.sweep(actor);
    expect(state.reads).toEqual([]);
  });

  it('reads each closed return once after the quiet period, then never again on a verdict', async () => {
    const { detector, state, later } = harness({ rows: [entry('r1'), entry('r2')] });
    later(QUIET);
    await detector.sweep(actor);
    await detector.sweep(actor);
    expect(state.reads).toEqual(['r1', 'r2']);
  });

  it('a late commit is a verdict too', async () => {
    const { detector, state, later } = harness({ rows: [entry('r1')], answers: ['late_commit'] });
    later(QUIET);
    await detector.sweep(actor);
    await detector.sweep(actor);
    expect(state.reads).toEqual(['r1']);
  });

  it.each<ClosedCheck>(['no_verdict', 'skipped'])('reads again after %s', async (first) => {
    const { detector, state, later } = harness({ rows: [entry('r1')], answers: [first, 'clear'] });
    later(QUIET);
    await detector.sweep(actor);
    await detector.sweep(actor);
    await detector.sweep(actor);
    expect(state.reads).toEqual(['r1', 'r1']);
  });

  it('an unreadable close time counts as due', async () => {
    const { detector, state } = harness({ rows: [entry('r1')], closedAt: 'not-a-time' });
    await detector.sweep(actor);
    expect(state.reads).toEqual(['r1']);
  });

  it('reads nothing once the domain is stopping, and stops part-way', async () => {
    let stopped = true;
    const h = harness({ rows: [entry('r1'), entry('r2')], stopped: () => stopped });
    h.later(QUIET);
    await h.detector.sweep(actor);
    expect(h.state.reads).toEqual([]);

    let calls = 0;
    stopped = false;
    const partWay = harness({
      rows: [entry('r1'), entry('r2')],
      stopped: () => {
        calls += 1;
        return calls > 2;
      },
    });
    partWay.later(QUIET);
    await partWay.detector.sweep(actor);
    expect(partWay.state.reads).toEqual(['r1']);
  });
});

describe('the check when a new return or void of the sale is quoted', () => {
  it('reads every closed return of that sale at once, whatever the quiet period', async () => {
    const { detector, state } = harness({ rows: [entry('r1'), entry('r2', 'sale-2')] });
    await expect(detector.checkSale(actor, 'sale-1')).resolves.toBe(false);
    expect(state.reads).toEqual(['r1']);
    expect(state.saleAsked).toEqual(['sale-1']);
  });

  it('says true when one of them is now a late commit', async () => {
    const { detector } = harness({
      rows: [entry('r1'), entry('r2')],
      answers: ['clear', 'late_commit'],
    });
    await expect(detector.checkSale(actor, 'sale-1')).resolves.toBe(true);
  });

  it('says false on no verdict (nothing is blocked or freed)', async () => {
    const { detector } = harness({ rows: [entry('r1')], answers: ['no_verdict'] });
    await expect(detector.checkSale(actor, 'sale-1')).resolves.toBe(false);
  });

  it('does not end the sweep (its quiet-period read still happens)', async () => {
    const { detector, state, later } = harness({ rows: [entry('r1')] });
    await detector.checkSale(actor, 'sale-1');
    later(QUIET);
    await detector.sweep(actor);
    expect(state.reads).toEqual(['r1', 'r1']);
  });

  it('a read that throws is logged and is no verdict, for the quote and for the sweep', async () => {
    const { detector, state, later } = harness({
      rows: [entry('r1'), entry('r2')],
      throwFor: ['r1'],
    });
    await expect(detector.checkSale(actor, 'sale-1')).resolves.toBe(false);
    later(QUIET);
    await detector.sweep(actor);
    await detector.sweep(actor);
    expect(state.logged).toEqual([
      'returns:late_commit_read_failed',
      'returns:late_commit_read_failed',
      'returns:late_commit_read_failed',
    ]);
    // r2 got its verdict on the first sweep; r1 is read again (no verdict).
    expect(state.reads).toEqual(['r1', 'r2', 'r1', 'r2', 'r1']);
  });

  it('reads nothing once the domain is stopping', async () => {
    const { detector, state } = harness({ rows: [entry('r1')], stopped: () => true });
    await expect(detector.checkSale(actor, 'sale-1')).resolves.toBe(false);
    expect(state.reads).toEqual([]);
  });
});
