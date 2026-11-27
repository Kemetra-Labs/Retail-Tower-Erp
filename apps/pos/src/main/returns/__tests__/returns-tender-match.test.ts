/**
 * RT-1498 confirm-by-read (review round) — the recorded allocations must be exactly the journaled ones.
 */
import { describe, expect, it } from 'vitest';

import { recordedTendersMatchRequest } from '../returns-tender-match.js';

const REF = '0192f5a2-3b4c-7d8e-9f01-0000000000a9';
const sent = (tenders: unknown): string => JSON.stringify({ refundTenders: tenders });

describe('recordedTendersMatchRequest', () => {
  it('matches the same allocation, whatever the decimal scale or ref case', () => {
    expect(
      recordedTendersMatchRequest(sent([{ method: 'cash', amount: '15.00', allocationRef: REF }]), [
        { method: 'cash', amount: '15.0000', allocationRef: REF.toUpperCase() },
      ]),
    ).toBe(true);
  });

  it('matches a pre-RT-1543 allocation with no ref on either side', () => {
    expect(
      recordedTendersMatchRequest(sent([{ method: 'cash', amount: '15.00' }]), [
        { method: 'cash', amount: '15.0000' },
      ]),
    ).toBe(true);
  });

  it.each([
    ['another amount', [{ method: 'cash', amount: '14.0000', allocationRef: REF }]],
    ['another method', [{ method: 'card_external', amount: '15.0000', allocationRef: REF }]],
    [
      'an originalTenderRef',
      [{ method: 'cash', amount: '15.0000', allocationRef: REF, originalTenderRef: REF }],
    ],
    [
      'one allocation more',
      [
        { method: 'cash', amount: '15.0000', allocationRef: REF },
        { method: 'cash', amount: '0.0000' },
      ],
    ],
    ['none at all', []],
    ['an unreadable amount', [{ method: 'cash', amount: 'x', allocationRef: REF }]],
  ])('does not match %s', (_name, recorded) => {
    expect(
      recordedTendersMatchRequest(
        sent([{ method: 'cash', amount: '15.00', allocationRef: REF }]),
        recorded,
      ),
    ).toBe(false);
  });

  it('does not match when either side cannot be read', () => {
    expect(recordedTendersMatchRequest('not json', [{ method: 'cash', amount: '1.00' }])).toBe(
      false,
    );
    expect(recordedTendersMatchRequest(sent('x'), [{ method: 'cash', amount: '1.00' }])).toBe(
      false,
    );
    expect(
      recordedTendersMatchRequest(sent([{ method: 'cash', amount: 1 }]), [
        { method: 'cash', amount: '1.00' },
      ]),
    ).toBe(false);
    expect(
      recordedTendersMatchRequest(sent([{ method: 'cash', amount: '1.00', allocationRef: 7 }]), [
        { method: 'cash', amount: '1.00', allocationRef: REF },
      ]),
    ).toBe(false);
    expect(recordedTendersMatchRequest(sent([{ method: 'cash', amount: '1.00' }]), null)).toBe(
      false,
    );
  });
});
