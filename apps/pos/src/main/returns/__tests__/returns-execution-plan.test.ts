/**
 * RT-1543 — the allocation refs of a new return and the execution bodies built from them.
 *
 *   • a new return body carries one `allocationRef` per refund tender, all or none (allocation
 *     rule 1 of `recordReturn`);
 *   • the stored body is read back all-or-none: a tender without a ref, a repeated ref, an
 *     unreadable body or an amount of 0 means NO execution (a legacy return, a zero-total return);
 *   • the execution body is the pinned `RecordRefundExecutionRequest`, byte-stable for one input.
 */
import { describe, expect, it } from 'vitest';

import type { PosSalesSales } from '../../../shared/api-types.js';
import {
  EXECUTION_EXTERNAL_ID_PREFIX,
  buildExecutionBody,
  evidenceMethodOf,
  readAllocations,
} from '../returns-execution-plan.js';
import { buildRecordReturnBody } from '../returns-quote.js';

const REF_A = '0190f5a2-7b3c-7d4e-8f90-0000000000a1';
const REF_B = '0190f5a2-7b3c-7d4e-8f90-0000000000b2';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const QUOTE = {
  saleRef: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6',
  currencyCode: 'EGP',
  lines: [{ lineRef: '0190f5a2-7b3c-7d4e-8f90-00000000000a', quantity: 1, amountMinor: 1500 }],
  totalMinor: 1500,
};

function body(refundTenders: unknown[]): string {
  return JSON.stringify({ sourceSystem: 'pos-pulse', externalId: 'x', lines: [], refundTenders });
}

describe('buildRecordReturnBody — allocation refs (new returns)', () => {
  it('puts the given allocationRef on the one refund tender', () => {
    const built = buildRecordReturnBody('pos-pulse-return:x', QUOTE, REF_A);
    expect(built.refundTenders).toEqual([
      { method: 'cash', amount: '15.00', allocationRef: REF_A },
    ]);
  });

  it('conforms to the pinned RecordReturnRequest (compile-time) with the same keys at runtime', () => {
    const built: PosSalesSales.components['schemas']['RecordReturnRequest'] = buildRecordReturnBody(
      'pos-pulse-return:x',
      QUOTE,
      REF_A,
    );
    expect(Object.keys(built.refundTenders[0] ?? {}).sort()).toEqual(
      ['allocationRef', 'amount', 'method'].sort(),
    );
  });

  it('without a ref (a legacy shape) sends the tender exactly as before', () => {
    const built = buildRecordReturnBody('pos-pulse-return:x', QUOTE);
    expect(JSON.stringify(built.refundTenders)).toBe('[{"method":"cash","amount":"15.00"}]');
  });
});

describe('readAllocations — all or none', () => {
  it('reads every tender when each carries a unique ref and a positive amount', () => {
    const json = body([
      { method: 'cash', amount: '6.00', allocationRef: REF_A },
      { method: 'cash', amount: '4.0000', allocationRef: REF_B },
    ]);
    expect(readAllocations(json)).toEqual([
      { allocationRef: REF_A, amount: '6.00' },
      { allocationRef: REF_B, amount: '4.0000' },
    ]);
  });

  it('reads nothing from a legacy body (no allocationRef at all)', () => {
    expect(readAllocations(body([{ method: 'cash', amount: '15.00' }]))).toEqual([]);
  });

  it('reads nothing when only some tenders carry a ref', () => {
    const json = body([
      { method: 'cash', amount: '6.00', allocationRef: REF_A },
      { method: 'cash', amount: '4.00' },
    ]);
    expect(readAllocations(json)).toEqual([]);
  });

  it('reads nothing when a ref repeats', () => {
    const json = body([
      { method: 'cash', amount: '6.00', allocationRef: REF_A },
      { method: 'cash', amount: '4.00', allocationRef: REF_A.toUpperCase() },
    ]);
    expect(readAllocations(json)).toEqual([]);
  });

  it.each(['0', '0.00', '0.0000'])('reads nothing for a zero amount (%s)', (amount) => {
    expect(readAllocations(body([{ method: 'cash', amount, allocationRef: REF_A }]))).toEqual([]);
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['no refundTenders', '{}'],
    ['an empty refundTenders', body([])],
    ['a non-uuid ref', body([{ method: 'cash', amount: '1.00', allocationRef: 'nope' }])],
    ['a numeric amount', body([{ method: 'cash', amount: 1, allocationRef: REF_A }])],
    ['a negative amount', body([{ method: 'cash', amount: '-1.00', allocationRef: REF_A }])],
  ])('reads nothing from %s', (_name, json) => {
    expect(readAllocations(json)).toEqual([]);
  });
});

describe('buildExecutionBody', () => {
  const input = {
    externalId: `${EXECUTION_EXTERNAL_ID_PREFIX}${REF_B}`,
    executionRef: REF_B,
    allocationRef: REF_A,
    amount: '15.00',
    method: 'drawer' as const,
    paidAt: '2026-11-21T10:00:00.000Z',
    shiftRef: '0190f5a2-7b3c-7d4e-8f90-0000000000c3',
  };

  it('is the pinned RecordRefundExecutionRequest, and the same bytes for the same input', () => {
    const json = buildExecutionBody(input);
    expect(buildExecutionBody({ ...input })).toBe(json);
    const parsed = JSON.parse(
      json,
    ) as PosSalesSales.components['schemas']['RecordRefundExecutionRequest'];
    expect(parsed).toEqual({
      sourceSystem: 'pos-pulse',
      externalId: input.externalId,
      executionRef: REF_B,
      allocationRef: REF_A,
      amount: '15.00',
      outcome: 'settled',
      evidence: { method: 'drawer', paidAt: input.paidAt, shiftRef: input.shiftRef },
    });
  });

  it('uses an Idempotency-Key-valid external id (16 to 128 printable characters)', () => {
    expect(input.externalId).toMatch(/^[\x21-\x7E]{16,128}$/);
    expect(input.externalId).toBe('pos-pulse-refund-exec:0190f5a2-7b3c-7d4e-8f90-0000000000b2');
  });
});

describe('evidenceMethodOf', () => {
  it('maps drawer to drawer, and manual and no_drawer to manual', () => {
    expect(evidenceMethodOf('drawer')).toBe('drawer');
    expect(evidenceMethodOf('manual')).toBe('manual');
    expect(evidenceMethodOf('no_drawer')).toBe('manual');
  });
});

it('sanity: the uuid pattern used by the tests accepts a v7', () => {
  expect(REF_A).toMatch(UUID_V7);
});
