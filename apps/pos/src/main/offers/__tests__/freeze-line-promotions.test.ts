/**
 * RT-1339 (RT-286 S7) — freezing the offers onto the sale's lines (spec 048 §6 step 6, OD-4):
 * the line split, the deterministic reward line ids, and the fail-closed refusals.
 */
import { describe, expect, it } from 'vitest';
import type { PromotionFact } from '../../../shared/offers/types.js';
import { freezeLinePromotions, rewardLineId } from '../freeze-line-promotions.js';
import type { SaleLineSnapshot } from '../../sales/freeze-line-discounts.js';

function line(over: Partial<SaleLineSnapshot> = {}): SaleLineSnapshot {
  return {
    line_id: 'line-1',
    item_ref: 'p1',
    display_name: 'A',
    quantity: 2,
    unit_price_minor: 15_000,
    line_subtotal_minor: 30_000,
    note: null,
    version: 1,
    last_action_id: 'act-1',
    ...over,
  };
}

function fact(rewards: number[], over: Partial<PromotionFact> = {}): PromotionFact {
  return {
    line_id: 'line-1',
    offer_id: '0a000000-0000-7000-8000-000000000001',
    offer_version: 3,
    pack_revision: 118,
    offer_name_ar: 'عرض',
    percent_off: 40,
    reward_discounts_minor: rewards,
    ...over,
  };
}

describe('freezeLinePromotions', () => {
  it('with no offer facts returns the very same lines', () => {
    const lines = [line()];
    const r = freezeLinePromotions(lines, [], 30_000);
    expect(r).toEqual({ kind: 'ok', lines });
    expect(r.kind === 'ok' && r.lines).toBe(lines);
  });

  it('E4: one reward unit of two becomes its own quantity-1 line after the rest', () => {
    const r = freezeLinePromotions([line()], [fact([6_000])], 24_000);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({
      line_id: 'line-1',
      quantity: 1,
      line_subtotal_minor: 15_000,
      promotion: { discount_minor: 0 },
    });
    expect(r.lines[1]).toMatchObject({
      quantity: 1,
      line_subtotal_minor: 15_000,
      promotion: { discount_minor: 6_000, offer_version: 3, pack_revision: 118 },
    });
    expect(r.lines[1]?.line_id).toBe(rewardLineId('line-1', 1));
  });

  it('every unit a reward: no rest line, one reward line per unit with its own id', () => {
    const r = freezeLinePromotions(
      [line({ quantity: 2, line_subtotal_minor: 30_000 })],
      [fact([6_000, 6_000])],
      18_000,
    );
    expect(r.kind === 'ok' && r.lines.map((l) => l.line_id)).toEqual([
      rewardLineId('line-1', 1),
      rewardLineId('line-1', 2),
    ]);
  });

  it('a participating line with no reward unit keeps its id and carries a 0 promotion', () => {
    const r = freezeLinePromotions(
      [line({ quantity: 1, line_subtotal_minor: 15_000 })],
      [fact([])],
      15_000,
    );
    expect(r.kind === 'ok' && r.lines).toMatchObject([
      { line_id: 'line-1', promotion: { discount_minor: 0 } },
    ]);
  });

  it('leaves lines without a fact untouched, in order', () => {
    const other = line({ line_id: 'line-2', quantity: 1, line_subtotal_minor: 15_000 });
    const r = freezeLinePromotions([other, line()], [fact([6_000])], 15_000 + 24_000);
    expect(r.kind === 'ok' && r.lines[0]).toBe(other);
  });

  it('derives the same ids every time and distinct ids per unit and per line', () => {
    expect(rewardLineId('a', 1)).toBe(rewardLineId('a', 1));
    expect(rewardLineId('a', 1)).not.toBe(rewardLineId('a', 2));
    expect(rewardLineId('a', 1)).not.toBe(rewardLineId('b', 1));
    expect(rewardLineId('a', 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it.each<[string, SaleLineSnapshot[], PromotionFact[], number]>([
    ['a settled amount that is not Σ net', [line()], [fact([6_000])], 24_001],
    ['more reward units than the line holds', [line()], [fact([1, 1, 1])], 30_000 - 3],
    ['a discount above the unit price', [line()], [fact([15_001])], 30_000 - 15_001],
    ['two facts on one line', [line()], [fact([6_000]), fact([6_000])], 18_000],
    [
      'a fact for a line that is not in the sale',
      [line()],
      [fact([6_000], { line_id: 'gone' })],
      30_000,
    ],
    [
      'a fact on a line with a manual discount (OD-5)',
      [
        line({
          discount: {
            kind: 'percent',
            value: 10,
            amount_minor: 3_000,
            placeholder_id: 'dp',
            reason_code: 'promotion',
            authority_source: 'manager_session',
            approver_operator_id: 'm',
          },
        }),
      ],
      [fact([6_000])],
      21_000,
    ],
    ['a fractional discount', [line()], [fact([5.5])], 30_000 - 5.5],
  ])('refuses %s', (_name, lines, facts, due) => {
    expect(freezeLinePromotions(lines, facts, due)).toEqual({
      kind: 'refused',
      reason: 'promotion_mismatch',
    });
  });
});
