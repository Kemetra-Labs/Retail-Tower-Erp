/**
 * RT-1339 (RT-286 S7) — the cart shows the automatic offers main evaluated: the copy under a
 * reward line, «خصم العروض» in the totals, the net total, and «العرض غير متاح بدون اتصال»
 * when a stored offer cannot be applied. The renderer only shows them (it has no control that
 * edits an offer), and a cart with no offer is drawn exactly as before.
 */
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { CartBridgeAPI } from '../../../shared/bridge-api';
import type { PromotionPreview } from '../../../shared/offers/types';
import { LiveSaleCart } from '../sale/LiveSaleCart';
import { cartSignature, usePromotionPreview } from '../sale/offers/offers-ui';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const LINE = {
  lineId: 'line-1',
  displayName: 'سماعة',
  quantity: 2,
  unitPriceMinor: 15_000,
  lineSubtotalMinor: 30_000,
  note: null,
  version: 1,
};

const OFFER = {
  line_id: 'line-1',
  offer_id: '0a000000-0000-7000-8000-000000000001',
  offer_version: 3,
  pack_revision: 118,
  offer_name_ar: 'القطعة التانية',
  percent_off: 40,
  reward_discounts_minor: [6_000],
};

const PREVIEW: PromotionPreview = {
  promotions: [OFFER],
  promotion_total_minor: 6_000,
  unavailable_offline: false,
};

function cart(over: Partial<Parameters<typeof LiveSaleCart>[0]> = {}) {
  return {
    lines: [LINE],
    discounts: [],
    subtotalMinor: 30_000,
    itemCount: 2,
    frozenSubtotalMinor: null,
    canHandoff: true,
    handingOff: false,
    cancelled: false,
    canVoid: true,
    canContinue: false,
    handoffError: null,
    onIncrement: vi.fn(),
    onDecrement: vi.fn(),
    onRemove: vi.fn(),
    onSaveNote: vi.fn().mockResolvedValue(true),
    onRemoveDiscount: vi.fn(),
    onHandoff: vi.fn(),
    onContinue: vi.fn(),
    onVoid: vi.fn().mockResolvedValue(true),
    ...over,
  } as Parameters<typeof LiveSaleCart>[0];
}

function row(label: string): HTMLElement | null {
  return screen.getByText(label).parentElement;
}

describe('RT-1339 the editing cart', () => {
  it('shows the offer copy and amount under the reward line, the offers total and the net', () => {
    render(<LiveSaleCart {...cart({ promotions: PREVIEW })} />);
    const promo = screen.getByTestId('line-promotion');
    expect(promo).toHaveTextContent('عرض: القطعة التانية (خصم 40%)');
    expect(promo).toHaveTextContent('−60.00 EGP');
    expect(row('خصم العروض')).toHaveTextContent('−60.00 EGP');
    expect(row('المجموع الفرعي')).toHaveTextContent('300.00 EGP');
    expect(row('الإجمالي الحالي')).toHaveTextContent('240.00 EGP');
  });

  it('shows the reward unit count when more than one unit takes the reward', () => {
    const preview: PromotionPreview = {
      ...PREVIEW,
      promotions: [{ ...OFFER, reward_discounts_minor: [6_000, 6_000] }],
      promotion_total_minor: 12_000,
    };
    render(<LiveSaleCart {...cart({ promotions: preview })} />);
    expect(screen.getByTestId('line-promotion')).toHaveTextContent('×2');
  });

  it('a participating line with no reward unit shows no offer row', () => {
    const preview: PromotionPreview = {
      promotions: [{ ...OFFER, reward_discounts_minor: [] }],
      promotion_total_minor: 0,
      unavailable_offline: false,
    };
    render(<LiveSaleCart {...cart({ promotions: preview })} />);
    expect(screen.queryByTestId('line-promotion')).toBeNull();
    expect(screen.queryByTestId('promotion-total')).toBeNull();
  });

  it('with no offer the cart is as before: no offer row, no offers total, the gross as the net', () => {
    render(<LiveSaleCart {...cart({ promotions: null })} />);
    expect(screen.queryByTestId('line-promotion')).toBeNull();
    expect(screen.queryByText('خصم العروض')).toBeNull();
    expect(row('الإجمالي الحالي')).toHaveTextContent('300.00 EGP');
  });

  it('says «العرض غير متاح بدون اتصال» when a stored offer cannot be applied', () => {
    const unavailable: PromotionPreview = {
      promotions: [],
      promotion_total_minor: 0,
      unavailable_offline: true,
    };
    render(<LiveSaleCart {...cart({ promotions: unavailable })} />);
    expect(screen.getByTestId('offer-unavailable-offline')).toHaveTextContent(
      'العرض غير متاح بدون اتصال',
    );
    expect(row('الإجمالي الحالي')).toHaveTextContent('300.00 EGP');
  });

  it('has no control that edits or removes an offer', () => {
    render(<LiveSaleCart {...cart({ promotions: PREVIEW })} />);
    const promo = screen.getByTestId('line-promotion');
    expect(promo.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('RT-1339 the frozen cart', () => {
  it('shows the offers the envelope froze, and its own amount due', () => {
    render(
      <LiveSaleCart
        {...cart({
          frozenSubtotalMinor: 30_000,
          frozenDiscountMinor: 0,
          frozenDueMinor: 24_000,
          frozenPromotions: [OFFER],
          frozenPromotionMinor: 6_000,
          // A live preview from a moment later must not change a frozen cart.
          promotions: { promotions: [], promotion_total_minor: 0, unavailable_offline: true },
        })}
      />,
    );
    expect(screen.getByTestId('line-promotion')).toHaveTextContent('−60.00 EGP');
    expect(row('خصم العروض')).toHaveTextContent('−60.00 EGP');
    expect(row('الإجمالي الحالي')).toHaveTextContent('240.00 EGP');
    expect(screen.queryByTestId('offer-unavailable-offline')).toBeNull();
  });
});

describe('RT-1339 usePromotionPreview', () => {
  interface Fake {
    bridge: CartBridgeAPI;
    ask: ReturnType<typeof vi.fn>;
  }

  function bridgeOf(answer: () => Promise<unknown>): Fake {
    const ask = vi.fn(answer);
    return { bridge: { promotionPreview: ask } as unknown as CartBridgeAPI, ask };
  }

  it('asks main for the cart and returns its answer', async () => {
    const fake = bridgeOf(() => Promise.resolve({ kind: 'ok', preview: PREVIEW }));
    const { result } = renderHook(() =>
      usePromotionPreview({
        bridge: fake.bridge,
        cartId: 'cart-1',
        enabled: true,
        signature: 's1',
      }),
    );
    await waitFor(() => {
      expect(result.current).toEqual(PREVIEW);
    });
    expect(fake.ask).toHaveBeenCalledWith({ cart_id: 'cart-1' });
  });

  it('shows no offer for a changed cart until main answers for the new state', async () => {
    const slow: Array<(v: unknown) => void> = [];
    const fake = bridgeOf(() => new Promise((resolve) => slow.push(resolve)));
    const { result, rerender } = renderHook(
      ({ cartId, signature }) =>
        usePromotionPreview({ bridge: fake.bridge, cartId, enabled: true, signature }),
      { initialProps: { cartId: 'cart-1', signature: 's1' } },
    );
    await act(async () => {
      slow[0]?.({ kind: 'ok', preview: PREVIEW });
      await Promise.resolve();
    });
    expect(result.current).toEqual(PREVIEW);
    // A quantity went down: the second answer is still pending, so the old discount must not show.
    rerender({ cartId: 'cart-1', signature: 's2' });
    expect(result.current).toBeNull();
    rerender({ cartId: 'cart-2', signature: 's2' });
    expect(result.current).toBeNull();
    expect(fake.ask).toHaveBeenCalledTimes(3);
  });

  it('asks again on a material cart change, and drops an older answer that lands late', async () => {
    const slow: Array<(v: unknown) => void> = [];
    const fake = bridgeOf(() => new Promise((resolve) => slow.push(resolve)));
    const { result, rerender } = renderHook(
      ({ signature }) =>
        usePromotionPreview({ bridge: fake.bridge, cartId: 'cart-1', enabled: true, signature }),
      { initialProps: { signature: 's1' } },
    );
    rerender({ signature: 's2' });
    await act(async () => {
      slow[1]?.({ kind: 'ok', preview: PREVIEW });
      await Promise.resolve();
    });
    await act(async () => {
      slow[0]?.({
        kind: 'ok',
        preview: { promotions: [], promotion_total_minor: 0, unavailable_offline: false },
      });
      await Promise.resolve();
    });
    expect(fake.ask).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(PREVIEW);
  });

  it('is null when disabled, when main refuses, and when the bridge is missing or fails', async () => {
    const refused = bridgeOf(() => Promise.resolve({ kind: 'refused', reason: 'wrong_owner' }));
    const { result } = renderHook(() =>
      usePromotionPreview({
        bridge: refused.bridge,
        cartId: 'cart-1',
        enabled: true,
        signature: 's',
      }),
    );
    await waitFor(() => {
      expect(refused.ask).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();

    const off = bridgeOf(() => Promise.resolve({ kind: 'ok', preview: PREVIEW }));
    const disabled = renderHook(() =>
      usePromotionPreview({ bridge: off.bridge, cartId: 'cart-1', enabled: false, signature: 's' }),
    );
    expect(disabled.result.current).toBeNull();
    expect(off.ask).not.toHaveBeenCalled();

    const none = renderHook(() =>
      usePromotionPreview({ bridge: null, cartId: 'cart-1', enabled: true, signature: 's' }),
    );
    expect(none.result.current).toBeNull();

    const failing = bridgeOf(() => Promise.reject(new Error('ipc')));
    const failed = renderHook(() =>
      usePromotionPreview({
        bridge: failing.bridge,
        cartId: 'cart-1',
        enabled: true,
        signature: 's',
      }),
    );
    await waitFor(() => {
      expect(failing.ask).toHaveBeenCalled();
    });
    expect(failed.result.current).toBeNull();
  });

  it('asks again on a timer, so an offer that starts or ends shows without a cart change', async () => {
    vi.useFakeTimers();
    const fake = bridgeOf(() => Promise.resolve({ kind: 'ok', preview: PREVIEW }));
    renderHook(() =>
      usePromotionPreview({ bridge: fake.bridge, cartId: 'cart-1', enabled: true, signature: 's' }),
    );
    expect(fake.ask).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fake.ask).toHaveBeenCalledTimes(2);
  });
});

describe('cartSignature', () => {
  it('changes with a quantity, a price or a manual discount, and with nothing else', () => {
    const base = [{ lineId: 'a', quantity: 1, unitPriceMinor: 100 }];
    const sig = cartSignature(base, []);
    expect(cartSignature([{ lineId: 'a', quantity: 2, unitPriceMinor: 100 }], [])).not.toBe(sig);
    expect(cartSignature([{ lineId: 'a', quantity: 1, unitPriceMinor: 101 }], [])).not.toBe(sig);
    expect(cartSignature(base, ['a'])).not.toBe(sig);
    expect(cartSignature(base, [null, undefined])).toBe(sig);
  });
});
