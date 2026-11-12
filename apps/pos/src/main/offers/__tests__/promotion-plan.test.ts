/**
 * RT-1339 (RT-286 S7) — which offers apply to a cart now: the spec 048 §6.1 worked
 * examples at the till (E1, E2, E4, E7), and the offline rules of §7 (a fresh Pack
 * applies offers, a stale one applies none, a restarted till applies none).
 */
import { describe, expect, it } from 'vitest';
import type { PlanLine } from '../../../shared/offers/types.js';
import { planPromotions } from '../promotion-plan.js';
import {
  OFFER_ID,
  P1,
  P2,
  P3,
  P4,
  clockedService,
  freshService,
  memoryStore,
  packBody,
  packOffer,
  TENANT,
} from './pack-fixture.js';

let seq = 0;
function line(
  productId: string,
  unitPriceMinor: number,
  quantity = 1,
  over: Partial<PlanLine> = {},
): PlanLine {
  seq += 1;
  return {
    line_id: `line-${String(seq)}`,
    item_ref: productId,
    quantity,
    unit_price_minor: unitPriceMinor,
    has_manual_discount: false,
    ...over,
  };
}

const plan = (lines: PlanLine[], c = freshService()) =>
  planPromotions(lines, c.service.view(), 'EGP');

describe('spec 048 §6.1 at the till', () => {
  it('E1: 300 and 200 → the 200 takes 40% (80.00)', () => {
    const lines = [line(P1, 30_000), line(P2, 20_000)];
    const r = plan(lines);
    expect(r.promotion_total_minor).toBe(8_000);
    expect(r.promotions).toEqual([
      {
        line_id: lines[0]?.line_id,
        offer_id: OFFER_ID,
        offer_version: 3,
        pack_revision: 118,
        offer_name_ar: 'القطعة التانية بخصم 40%',
        percent_off: 40,
        reward_discounts_minor: [],
      },
      {
        line_id: lines[1]?.line_id,
        offer_id: OFFER_ID,
        offer_version: 3,
        pack_revision: 118,
        offer_name_ar: 'القطعة التانية بخصم 40%',
        percent_off: 40,
        reward_discounts_minor: [8_000],
      },
    ]);
    expect(r.unavailable_offline).toBe(false);
  });

  it('E2: 100, 80, 60, 40 → the two cheapest take it (24.00 + 16.00)', () => {
    const lines = [line(P1, 10_000), line(P2, 8_000), line(P3, 6_000), line(P4, 4_000)];
    const r = plan(lines);
    expect(r.promotion_total_minor).toBe(4_000);
    expect(r.promotions.map((f) => f.reward_discounts_minor)).toEqual([[], [], [2_400], [1_600]]);
  });

  it('E4: product A 150.00 × 2 on one line → one reward unit of 60.00 on that line', () => {
    const lines = [line(P1, 15_000, 2)];
    const r = plan(lines);
    expect(r.promotion_total_minor).toBe(6_000);
    expect(r.promotions).toHaveLength(1);
    expect(r.promotions[0]).toMatchObject({
      line_id: lines[0]?.line_id,
      reward_discounts_minor: [6_000],
    });
  });

  it('E7: a line with a manual discount does not take part, so one eligible unit gives no offer', () => {
    const lines = [line(P1, 10_000, 1, { has_manual_discount: true }), line(P2, 6_000)];
    const r = plan(lines);
    expect(r.promotions).toEqual([]);
    expect(r.promotion_total_minor).toBe(0);
  });

  it('a manual discount on the cheaper line leaves the others to pair among themselves', () => {
    const lines = [
      line(P1, 10_000),
      line(P2, 4_000, 1, { has_manual_discount: true }),
      line(P3, 8_000),
    ];
    const r = plan(lines);
    expect(r.promotion_total_minor).toBe(3_200); // 40% of 80.00; the discounted 40.00 line is out
    expect(r.promotions.map((f) => f.line_id)).toEqual([lines[0]?.line_id, lines[2]?.line_id]);
  });

  it('re-evaluates from scratch: adding a unit moves the reward to the new cheapest', () => {
    const two = [line(P1, 30_000), line(P2, 20_000)];
    expect(plan(two).promotion_total_minor).toBe(8_000);
    const three = [...two, line(P3, 5_000)];
    expect(plan(three).promotion_total_minor).toBe(2_000); // one application: the 50.00 unit
  });

  it('a product outside every eligible set takes no part', () => {
    const r = plan([line('dd000000-0000-7000-8000-000000000009', 10_000), line(P1, 5_000)]);
    expect(r.promotions).toEqual([]);
  });

  it('matches item_ref to product ids case-insensitively', () => {
    const r = plan([line(P1.toUpperCase(), 10_000), line(P2.toUpperCase(), 5_000)]);
    expect(r.promotion_total_minor).toBe(2_000);
  });

  it('an empty cart and a till with no Pack plan nothing', () => {
    expect(plan([]).promotions).toEqual([]);
    const none = planPromotions([line(P1, 100)], clockedService().service.view(), 'EGP');
    expect(none).toEqual({ promotions: [], promotion_total_minor: 0, unavailable_offline: false });
  });

  it('applies several offers over their own disjoint products', () => {
    const second = packOffer({
      offerId: '0a000000-0000-7000-8000-000000000002',
      percentOff: '50',
      eligibleProductIds: [P3, P4],
    });
    const body = packBody({ offers: [packOffer({ eligibleProductIds: [P1, P2] }), second] });
    const r = plan(
      [line(P1, 10_000), line(P2, 6_000), line(P3, 8_000), line(P4, 4_000)],
      freshService(body),
    );
    expect(r.promotion_total_minor).toBe(2_400 + 2_000);
  });
});

describe('spec 048 §7: windows, freshness and offline', () => {
  const pair = (): PlanLine[] => [line(P1, 30_000), line(P2, 20_000)];

  it('a fresh Pack applies the offer', () => {
    expect(plan(pair()).promotion_total_minor).toBe(8_000);
  });

  it('a stale Pack (past the window) applies none and says why', () => {
    const c = freshService();
    c.advance(24 * 3_600_000);
    expect(plan(pair(), c)).toEqual({
      promotions: [],
      promotion_total_minor: 0,
      unavailable_offline: true,
    });
  });

  it('a restart without a fresh Pack applies no offer and shows the offline notice', () => {
    const before = freshService();
    const after = clockedService(memoryStore(before.store.saved));
    after.service.restore(TENANT);
    expect(plan(pair(), after)).toEqual({
      promotions: [],
      promotion_total_minor: 0,
      unavailable_offline: true,
    });
  });

  it('the notice appears only when a stored offer covers a cart line', () => {
    const before = freshService();
    const after = clockedService(memoryStore(before.store.saved));
    after.service.restore(TENANT);
    const r = plan([line('dd000000-0000-7000-8000-000000000009', 10_000)], after);
    expect(r.unavailable_offline).toBe(false);
  });

  it('a scheduled offer that has not started on the trusted clock does not apply (and no notice)', () => {
    const c = freshService(
      packBody({ offers: [packOffer({ startsAt: '2026-11-12T10:30:00.000Z' })] }),
    );
    expect(plan(pair(), c).promotions).toEqual([]);
    c.advance(29 * 60_000);
    expect(plan(pair(), c).promotions).toEqual([]);
    c.advance(60_000);
    expect(plan(pair(), c).promotion_total_minor).toBe(8_000);
  });

  it('an offer ends at endsAt on the trusted clock, exclusive', () => {
    const c = freshService(
      packBody({ offers: [packOffer({ endsAt: '2026-11-12T10:05:00.000Z' })] }),
    );
    c.advance(5 * 60_000 - 1);
    expect(plan(pair(), c).promotion_total_minor).toBe(8_000);
    c.advance(1);
    expect(plan(pair(), c).promotions).toEqual([]);
  });

  it('an online_only offer applies while a read is recent, and is skipped offline', () => {
    const body = packBody({ offers: [packOffer({ offlinePolicy: 'online_only' })] });
    const c = freshService(body);
    expect(plan(pair(), c).promotion_total_minor).toBe(8_000);
    c.advance(10 * 60_000 + 1);
    expect(plan(pair(), c)).toEqual({
      promotions: [],
      promotion_total_minor: 0,
      unavailable_offline: true,
    });
  });

  it('applies no offer when the Pack currency is not the till currency (XXX included)', () => {
    expect(
      plan(pair(), freshService(packBody({ currencyCode: 'XXX', offers: [] }))).promotions,
    ).toEqual([]);
    expect(planPromotions(pair(), freshService().service.view(), 'USD').promotions).toEqual([]);
  });
});
