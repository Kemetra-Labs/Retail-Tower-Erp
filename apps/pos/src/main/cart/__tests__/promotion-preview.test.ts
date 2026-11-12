/**
 * RT-1339 (RT-286 S7) — the cart's offer preview: a pure projection of the live lines
 * (a line with a manual-discount placeholder never takes part, OD-5).
 */
import { describe, expect, it, vi } from 'vitest';
import { NO_PROMOTIONS, type PromotionPreview } from '../../../shared/offers/types.js';
import type { CartStore } from '../cart-store.js';
import { previewCartPromotions, type PlanPromotions } from '../promotion-preview.js';

function storeOf(
  lines: Array<{ line_id: string; item_ref: string; quantity: number; unit_price_minor: number }>,
  placeholderLineIds: string[] = [],
): { store: CartStore; getActiveLines: ReturnType<typeof vi.fn> } {
  const getActiveLines = vi.fn(() => lines);
  const store = {
    getActiveLines,
    getDiscountPlaceholdersForCart: vi.fn(() => placeholderLineIds.map((line_id) => ({ line_id }))),
  } as unknown as CartStore;
  return { store, getActiveLines };
}

const SOME: PromotionPreview = { ...NO_PROMOTIONS, promotion_total_minor: 8_000 };

describe('previewCartPromotions', () => {
  it('plans no offer when no planner is wired', () => {
    const { store, getActiveLines } = storeOf([
      { line_id: 'l1', item_ref: 'p1', quantity: 1, unit_price_minor: 100 },
    ]);
    expect(previewCartPromotions(store, 'cart-1', undefined)).toBe(NO_PROMOTIONS);
    expect(getActiveLines).not.toHaveBeenCalled();
  });

  it('plans no offer for an empty cart without asking the planner', () => {
    const plan = vi.fn<PlanPromotions>(() => SOME);
    expect(previewCartPromotions(storeOf([]).store, 'cart-1', plan)).toBe(NO_PROMOTIONS);
    expect(plan).not.toHaveBeenCalled();
  });

  it('hands the planner the live lines, marking a manually discounted one', () => {
    const plan = vi.fn<PlanPromotions>(() => SOME);
    const { store, getActiveLines } = storeOf(
      [
        { line_id: 'l1', item_ref: 'p1', quantity: 1, unit_price_minor: 30_000 },
        { line_id: 'l2', item_ref: 'p2', quantity: 2, unit_price_minor: 20_000 },
      ],
      ['l2'],
    );
    expect(previewCartPromotions(store, 'cart-1', plan)).toBe(SOME);
    expect(getActiveLines).toHaveBeenCalledWith('cart-1');
    expect(plan).toHaveBeenCalledWith([
      {
        line_id: 'l1',
        item_ref: 'p1',
        quantity: 1,
        unit_price_minor: 30_000,
        has_manual_discount: false,
      },
      {
        line_id: 'l2',
        item_ref: 'p2',
        quantity: 2,
        unit_price_minor: 20_000,
        has_manual_discount: true,
      },
    ]);
  });
});
