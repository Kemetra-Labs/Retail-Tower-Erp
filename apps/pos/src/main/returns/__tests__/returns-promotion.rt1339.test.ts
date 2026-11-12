/**
 * RT-1339 (RT-286 S7, spec 048 §9, OD-10 / OD-11 interim) — the till's return flow with automatic
 * offers: Backend-Core is the authority for the clawback, so the till
 *   • tells the two offer refusals (422 `promotion_clawback_exceeds_refund` and
 *     `promotion_return_requires_clawback`) apart from a tender mismatch, on a first send and a resend,
 *   • reads a sale line's frozen `promotion` only to mark it (never to price a return), and
 *   • keeps reading a sale whose lines carry it, and a recorded return that carries `promotionClawbacks`.
 */
import { describe, expect, it } from 'vitest';

import { classifyRefusal } from '../returns-client.js';
import { quoteReturn, viewLines } from '../returns-quote.js';
import {
  readSaleBody,
  readSaleReturnBody,
  type WireSale,
  type WireSaleLine,
} from '../returns-wire.js';
import { refusalMessage } from '../../../renderer/returns/returns-messages.js';

const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const REWARD = '0190f5a2-7b3c-7d4e-8f90-00000000000a';
const PLAIN = '0190f5a2-7b3c-7d4e-8f90-00000000000b';
const BASE = {
  currencyCode: 'EGP',
  unitPrice: '150.0000',
  returnedQuantity: '0.000000',
  returnableQuantity: '1.000000',
  quantity: '1.000000',
};

function sale(): Record<string, unknown> {
  return {
    saleRef: SALE_REF,
    currencyCode: 'EGP',
    voided: false,
    lines: [
      { ...BASE, lineRef: PLAIN, lineName: 'A', lineAmount: '150.0000' },
      {
        ...BASE,
        lineRef: REWARD,
        lineName: 'A',
        lineAmount: '90.0000',
        promotion: {
          offerId: '0a000000-0000-7000-8000-000000000001',
          offerVersion: 3,
          packRevision: 118,
          discountAmount: '60.0000',
        },
      },
    ],
  };
}

describe('the two offer refusals', () => {
  it.each(['promotion_clawback_exceeds_refund', 'promotion_return_requires_clawback'])(
    '422 %s is its own refusal, not a tender mismatch',
    (code) => {
      expect(classifyRefusal(422, code)).toBe(code);
    },
  );

  it('any other 422 is still a tender mismatch, and the same codes on another status are not offer refusals', () => {
    expect(classifyRefusal(422, null)).toBe('return_tender_mismatch');
    expect(classifyRefusal(422, 'something_else')).toBe('return_tender_mismatch');
    expect(classifyRefusal(409, 'promotion_clawback_exceeds_refund')).toBe('conflict');
    expect(classifyRefusal(400, 'promotion_return_requires_clawback')).toBe('validation_error');
  });

  it('each has Arabic cashier guidance that says nothing was recorded or paid', () => {
    const exceeds = refusalMessage('promotion_clawback_exceeds_refund');
    const requires = refusalMessage('promotion_return_requires_clawback');
    expect(exceeds).not.toBe(requires);
    for (const message of [exceeds, requires]) {
      expect(message).toMatch(/[؀-ۿ]/);
      expect(message).toContain('لم يُسجَّل المرتجع');
      expect(message).toContain('لم يُصرف أي نقد');
    }
    // OD-10 and the OD-11 interim: Backend-Core refuses every return with a reward line for now, so
    // "add the reward units" would only meet another refusal. Both send the cashier to the manager.
    for (const message of [exceeds, requires]) {
      expect(message).toContain('راجع المدير');
      expect(message).not.toContain('أضف إلى المرتجع');
    }
  });
});

describe('a sale whose lines carry a promotion', () => {
  it('is still readable (the reader ignores what it does not need) and keeps the discount', () => {
    const read = readSaleBody(sale());
    expect(read?.lines.map((l) => l.promotion?.discountAmount)).toEqual([undefined, '60.0000']);
  });

  it('marks the reward unit and a participant, and leaves a plain line unmarked', () => {
    const wire = readSaleBody(sale()) as WireSale;
    const withParticipant: WireSale = {
      ...wire,
      lines: [
        ...wire.lines,
        {
          ...(wire.lines[1] as WireSaleLine),
          lineRef: '0190f5a2-7b3c-7d4e-8f90-00000000000c',
          promotion: { discountAmount: '0.0000' },
        },
      ],
    };
    expect(viewLines(withParticipant).map((l) => l.offerRole)).toEqual([
      undefined,
      'reward',
      'participant',
    ]);
    expect(viewLines(wire).map((l) => 'offerRole' in l)).toEqual([false, true]);
  });

  it('a line with an offer that is unreadable is a read failure, never a guessed price', () => {
    const bad = sale();
    const lines = bad['lines'] as Array<Record<string, unknown>>;
    lines[1] = { ...lines[1], promotion: { discountAmount: 60 } };
    expect(readSaleBody(bad)).toBeNull();
  });

  it('prices a reward unit by its net, as the contract rule does (the server decides the rest)', () => {
    const wire = readSaleBody(sale()) as WireSale;
    const out = quoteReturn(wire, [{ lineRef: REWARD, quantity: 1 }]);
    expect(out).toMatchObject({ kind: 'ok', quote: { totalMinor: 9_000 } });
  });
});

describe('a recorded return that carries promotionClawbacks', () => {
  it('is still read: the clawback fields are additive', () => {
    const read = readSaleReturnBody({
      returnRef: '0190f5a2-7b3c-7d4e-8f90-0000000000ff',
      saleRef: SALE_REF,
      externalId: 'pos-pulse-return:x',
      currencyCode: 'EGP',
      returnTotal: '200.0000',
      recordedAt: '2026-11-12T10:00:00Z',
      lines: [{ lineRef: PLAIN, quantity: '1.000000' }],
      promotionClawbacks: [
        { offerId: '0a000000-0000-7000-8000-000000000001', offerVersion: 3, amount: '80.0000' },
      ],
    });
    expect(read?.returnTotal).toBe('200.0000');
  });
});
