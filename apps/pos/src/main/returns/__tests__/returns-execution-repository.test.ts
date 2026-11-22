/**
 * RT-1543 — the refund-execution outbox repository and its enqueue edges.
 *
 *   • reads, per-return and per-terminal listings (another terminal's rows are never listed);
 *   • every state change is a guarded UPDATE: only a pending / unknown row moves, and once a row
 *     is recorded or refused every further change reports false and writes nothing;
 *   • the enqueuer: no usable refs, no return ref, a failing shift read, the shift lookup.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ReturnPayoutMethod } from '../../../shared/returns/types.js';
import {
  createExecutionEnqueuer,
  openShiftRefOf,
  shiftRefAtOf,
  type ExecutionEnqueueDeps,
} from '../returns-execution-enqueue.js';
import {
  createReturnExecutionsRepository,
  type ExecutionEntry,
  type NewExecution,
  type ReturnExecutionsRepository,
} from '../returns-execution-repository.js';
import type { JournalEntry } from '../returns-repository.js';
import {
  NOW,
  SALE_REF,
  SCOPE,
  SHIFT_REF,
  confirmedReturn,
  initReturnsSql,
  jsonResponse,
  errorBody,
  returnsHarness,
  seedSyncedSale,
  secondsAfterNow,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;
let repo: ReturnExecutionsRepository;
let returnId: string;
let first: ExecutionEntry;

beforeEach(async () => {
  h = returnsHarness();
  seedSyncedSale(h.db);
  repo = createReturnExecutionsRepository(h.handle);
  // A paid-out return whose execution is left unknown (the answer never counted).
  h.backend.onExecution = () => Promise.resolve(jsonResponse(503, errorBody('unavailable')));
  returnId = await confirmedReturn(h.service);
  await h.service.payout({ returnId, action: 'start' });
  await h.resolver.drain(1_000);
  const [row] = repo.listForReturn(returnId);
  if (row === undefined) throw new Error('no execution row');
  first = row;
});

afterEach(() => {
  h.close();
});

describe('reads and listings', () => {
  it('reads a row by id, and null for an unknown id', () => {
    expect(repo.read(first.executionId)).toEqual(first);
    expect(repo.read('0190f5a2-7b3c-7d4e-8f90-0000000000ee')).toBeNull();
    expect(first).toMatchObject({ state: 'unknown', attemptCount: 1, returnId });
  });

  it('lists a return’s rows, and none for another return', () => {
    expect(repo.listForReturn(returnId)).toHaveLength(1);
    expect(repo.listForReturn('another-return')).toEqual([]);
  });

  it('lists this terminal’s open rows only', () => {
    expect(repo.listUnrecorded(SCOPE).map((e) => e.executionId)).toEqual([first.executionId]);
    expect(repo.listUnrecorded({ ...SCOPE, terminalId: 'term-2' })).toEqual([]);
    expect(repo.listUnrecorded({ ...SCOPE, branchId: 'branch-2' })).toEqual([]);
    expect(repo.listUnrecorded({ ...SCOPE, tenantId: 'tenant-2' })).toEqual([]);
  });
});

describe('guarded transitions', () => {
  const stamp = (n: number) => ({ executionId: first.executionId, now: secondsAfterNow(n) });

  it('records an attempt only while the row is open', () => {
    repo.recordAttempt(stamp(1));
    expect(repo.read(first.executionId)).toMatchObject({
      attemptCount: 2,
      lastAttemptAt: secondsAfterNow(1),
    });
    expect(repo.markRecorded(stamp(2))).toBe(true);
    repo.recordAttempt(stamp(3));
    expect(repo.read(first.executionId)?.attemptCount).toBe(2);
  });

  it('markUnknown keeps an unknown row unknown; markRecorded is final and once', () => {
    expect(repo.markUnknown(stamp(1))).toBe(true);
    expect(repo.markRecorded(stamp(2))).toBe(true);
    expect(repo.read(first.executionId)).toMatchObject({
      state: 'recorded',
      recordedAt: secondsAfterNow(2),
    });
    expect(repo.markRecorded(stamp(3))).toBe(false);
    expect(repo.markUnknown(stamp(3))).toBe(false);
    expect(repo.markRefused({ ...stamp(3), reason: 'conflict' })).toBe(false);
    expect(repo.read(first.executionId)).toMatchObject({
      state: 'recorded',
      recordedAt: secondsAfterNow(2),
      refusalReason: null,
    });
  });

  it('markRefused is final and once, and keeps its reason', () => {
    expect(repo.markRefused({ ...stamp(1), reason: 'exceeds_allocation' })).toBe(true);
    expect(repo.markRefused({ ...stamp(2), reason: 'conflict' })).toBe(false);
    expect(repo.markRecorded(stamp(2))).toBe(false);
    expect(repo.markUnknown(stamp(2))).toBe(false);
    expect(repo.read(first.executionId)).toMatchObject({
      state: 'refused',
      refusalReason: 'exceeds_allocation',
      recordedAt: null,
    });
    expect(repo.listUnrecorded(SCOPE)).toEqual([]);
  });
});

describe('the enqueuer', () => {
  const REF_A = '0190f5a2-7b3c-7d4e-8f90-0000000000a1';
  const warnings: string[] = [];

  function entryWith(over: Partial<JournalEntry>): JournalEntry {
    const body = JSON.stringify({
      refundTenders: [{ method: 'cash', amount: '15.00', allocationRef: REF_A }],
    });
    return {
      returnId: 'r-x',
      scope: SCOPE,
      saleId: 'sale-1',
      saleNumber: 'SN-1',
      serverSaleRef: SALE_REF,
      externalId: 'pos-pulse-return:x',
      operatorId: 'op',
      operatorSessionId: 'sess',
      currencyCode: 'EGP',
      quotedTotalMinor: 1500,
      requestBodyJson: body,
      lines: [],
      state: 'confirmed',
      returnRef: '0190f5a2-7b3c-7d4e-8f90-0000000000ff',
      returnTotalMinor: 1500,
      refusalReason: null,
      attemptCount: 1,
      lastAttemptAt: null,
      createdAt: NOW,
      confirmedAt: NOW,
      ...over,
    };
  }

  function enqueuer(over: Partial<ExecutionEnqueueDeps> = {}) {
    const enqueued: NewExecution[][] = [];
    warnings.length = 0;
    const enqueue = createExecutionEnqueuer({
      repo: { enqueue: (rows) => void enqueued.push([...rows]) },
      openShiftRef: () => SHIFT_REF,
      shiftRefAt: () => null,
      newExecutionRef: () => '0190f5a2-7b3c-7d4e-8f90-0000000000e9',
      logger: { warn: (_o, msg) => void warnings.push(msg) },
      ...over,
    });
    return { enqueue, enqueued };
  }

  const pay = (method: ReturnPayoutMethod = 'drawer') => method;
  const CLAIMED = secondsAfterNow(-60);
  const CLAIM_SHIFT = '0190f5a2-7b3c-7d4e-8f90-0000000000c4';

  it('enqueues one frozen row per allocation', () => {
    const { enqueue, enqueued } = enqueuer();
    enqueue(entryWith({}), pay(), NOW, CLAIMED);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toHaveLength(1);
    expect(enqueued[0]?.[0]).toMatchObject({
      allocationRef: REF_A,
      executionId: '0190f5a2-7b3c-7d4e-8f90-0000000000e9',
      externalId: 'pos-pulse-refund-exec:0190f5a2-7b3c-7d4e-8f90-0000000000e9',
      now: NOW,
    });
    expect(warnings).toEqual([]);
  });

  it('enqueues nothing for a body with no usable refs, and says nothing', () => {
    const { enqueue, enqueued } = enqueuer();
    enqueue(
      entryWith({ requestBodyJson: '{"refundTenders":[{"method":"cash","amount":"1.00"}]}' }),
      pay(),
      NOW,
      CLAIMED,
    );
    expect(enqueued).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('enqueues nothing, with a warning, when the return has no server ref', () => {
    const { enqueue, enqueued } = enqueuer();
    enqueue(entryWith({ returnRef: null }), pay(), NOW, CLAIMED);
    expect(enqueued).toEqual([]);
    expect(warnings).toEqual(['returns:execution_no_return_ref']);
  });

  it('with no shift open now, reports the shift that was open when the payout was claimed', () => {
    const asked: unknown[] = [];
    const { enqueue, enqueued } = enqueuer({
      openShiftRef: () => null,
      shiftRefAt: (scope, at) => {
        asked.push([scope, at]);
        return CLAIM_SHIFT;
      },
    });
    enqueue(entryWith({}), pay(), NOW, CLAIMED);
    expect(asked).toEqual([[SCOPE, CLAIMED]]);
    expect(enqueued).toHaveLength(1);
    const body = JSON.parse(enqueued[0]?.[0]?.requestBodyJson ?? '{}') as {
      evidence: { shiftRef: string };
    };
    expect(body.evidence.shiftRef).toBe(CLAIM_SHIFT);
    expect(warnings).toEqual([]);
  });

  it('prefers the shift open now: the claim-time records are not even read', () => {
    const asked: unknown[] = [];
    const { enqueue, enqueued } = enqueuer({
      shiftRefAt: (scope, at) => {
        asked.push([scope, at]);
        return CLAIM_SHIFT;
      },
    });
    enqueue(entryWith({}), pay(), NOW, CLAIMED);
    const body = JSON.parse(enqueued[0]?.[0]?.requestBodyJson ?? '{}') as {
      evidence: { shiftRef: string };
    };
    expect(body.evidence.shiftRef).toBe(SHIFT_REF);
    expect(asked).toEqual([]);
  });

  it('no shift now and none at the claim: nothing enqueued, the no-open-shift warning', () => {
    const { enqueue, enqueued } = enqueuer({ openShiftRef: () => null, shiftRefAt: () => null });
    enqueue(entryWith({}), pay(), NOW, CLAIMED);
    expect(enqueued).toEqual([]);
    expect(warnings).toEqual(['returns:execution_no_open_shift']);
  });

  it('a failing claim-time read counts as no shift: nothing enqueued, never a throw', () => {
    const { enqueue, enqueued } = enqueuer({
      openShiftRef: () => null,
      shiftRefAt: () => {
        throw new Error('db busy');
      },
    });
    expect(() => {
      enqueue(entryWith({}), pay(), NOW, CLAIMED);
    }).not.toThrow();
    expect(enqueued).toEqual([]);
    expect(warnings).toEqual([
      'returns:execution_claim_shift_read_failed',
      'returns:execution_no_open_shift',
    ]);
  });

  it('a failing shift read counts as no shift: nothing enqueued, never a throw', () => {
    const { enqueue, enqueued } = enqueuer({
      openShiftRef: () => {
        throw new Error('db busy');
      },
    });
    expect(() => {
      enqueue(entryWith({}), pay(), NOW, CLAIMED);
    }).not.toThrow();
    expect(enqueued).toEqual([]);
    expect(warnings).toEqual([
      'returns:execution_shift_read_failed',
      'returns:execution_no_open_shift',
    ]);
  });
});

describe('shiftRefAtOf', () => {
  it('is the shift id the shift records name at the instant, or null', () => {
    expect(shiftRefAtOf({ findShiftAt: () => SHIFT_REF })(SCOPE, NOW)).toBe(SHIFT_REF);
    expect(shiftRefAtOf({ findShiftAt: () => null })(SCOPE, NOW)).toBeNull();
  });
});

describe('openShiftRefOf', () => {
  it('is the open shift id, or null when none is open', () => {
    const open = { shiftId: SHIFT_REF } as NonNullable<
      ReturnType<Parameters<typeof openShiftRefOf>[0]['findOpenShift']>
    >;
    expect(openShiftRefOf({ findOpenShift: () => open })(SCOPE)).toBe(SHIFT_REF);
    expect(openShiftRefOf({ findOpenShift: () => null })(SCOPE)).toBeNull();
  });
});
