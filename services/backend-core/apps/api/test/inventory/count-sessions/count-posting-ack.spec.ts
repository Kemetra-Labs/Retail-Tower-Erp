/**
 * RT-1423 — the chunk ack line rules (pure): the results must be exactly the chunk's lines, a rejected
 * line carries its refusal, an adjusted or no-op line carries the verified quantity.
 */
import { CountAckLinesError, checkLinesMatch, type AckLine } from '../../../src/inventory/count-sessions/count-posting-ack';

const ok = (n: number): AckLine => ({ lineSeq: n, result: 'adjusted', verifiedQtyAfter: '7.0000', refusal: null });
const noop = (n: number): AckLine => ({ lineSeq: n, result: 'verified_noop', verifiedQtyAfter: '7.0000', refusal: null });
const rejected = (n: number): AckLine => ({
  lineSeq: n,
  result: 'rejected',
  verifiedQtyAfter: null,
  refusal: { code: 'uom_mismatch', message: 'unit is not the stock UOM' },
});

describe('checkLinesMatch', () => {
  it('accepts exactly the chunk lines, in any order, mixing results', () => {
    expect(() => checkLinesMatch([1, 2, 3], [rejected(3), ok(1), noop(2)])).not.toThrow();
  });

  it('refuses a missing, unknown or repeated line', () => {
    expect(() => checkLinesMatch([1, 2], [ok(1)])).toThrow(CountAckLinesError);
    expect(() => checkLinesMatch([1, 2], [ok(1), ok(2), ok(3)])).toThrow(/not a line of this chunk/);
    expect(() => checkLinesMatch([1, 2], [ok(1), ok(1)])).toThrow(/twice/);
  });

  it('refuses a rejected line without its refusal and a confirmed line without its quantity', () => {
    expect(() => checkLinesMatch([1], [{ lineSeq: 1, result: 'rejected', verifiedQtyAfter: null, refusal: null }])).toThrow(
      /no refusal/,
    );
    expect(() =>
      checkLinesMatch([1], [{ lineSeq: 1, result: 'adjusted', verifiedQtyAfter: null, refusal: null }]),
    ).toThrow(/no verifiedQtyAfter/);
  });
});
