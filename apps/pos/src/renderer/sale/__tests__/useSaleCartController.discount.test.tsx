/**
 * RT-855 — the cart controller's side of the manual discount: the add's
 * payload on each path (doc 28 §4.1 step 5, §4.2), main's answer passed back
 * untouched, and the discount's details kept for a re-read of the cart.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CartBridgeAPI } from '../../../shared/bridge-api';
import type { CartSnapshot } from '../../../shared/cart/bridge-types';
import { CartState } from '../../../shared/cart/cart-state';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import { useCartStore } from '../../stores/cart-store';
import { useDiscountDetailsStore } from '../../stores/discount-details-store';
import { useSaleCartController } from '../useSaleCartController';

function bridgeWith(add: ReturnType<typeof vi.fn>, snapshot?: ReturnType<typeof vi.fn>) {
  return {
    create: vi.fn(),
    lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add, remove: vi.fn().mockResolvedValue({ kind: 'ok' }) },
    void: vi.fn(),
    handoff: vi.fn(),
    subscribe: vi.fn(),
    ...(snapshot === undefined ? {} : { snapshot }),
  } as unknown as CartBridgeAPI;
}

const OK = { kind: 'ok', placeholder_id: 'dp-1', requires_manager_attribution: false };

afterEach(() => {
  useCartStore.getState().reset();
  useDiscountDetailsStore.getState().reset();
});

describe('useSaleCartController.addDiscount', () => {
  it('cashier: carries only the approval id, then shows the discount with its details', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const add = vi.fn().mockResolvedValue(OK);
    const { result } = renderHook(() => useSaleCartController({ bridge: bridgeWith(add) }));
    let answer: unknown;
    await act(async () => {
      answer = await result.current.addDiscount({
        lineId: 'line-1',
        token: 'manual_pct_10',
        reasonCode: 'promotion',
        approvalId: 'appr-1',
        approverName: 'سارة',
      });
    });
    expect(answer).toEqual(OK);
    expect(add).toHaveBeenCalledWith({
      cart_id: 'cart-1',
      line_id: 'line-1',
      placeholder_kind: 'manual_pct_10',
      idempotency_key: expect.any(String) as string,
      approval_id: 'appr-1',
    });
    expect(result.current.discountPlaceholders).toEqual([
      {
        placeholderId: 'dp-1',
        lineId: 'line-1',
        attribution_operator_id: null,
        token: 'manual_pct_10',
        reasonCode: 'promotion',
        approverName: 'سارة',
      },
    ]);
    expect(useDiscountDetailsStore.getState().byPlaceholder['dp-1']).toEqual({
      token: 'manual_pct_10',
      reasonCode: 'promotion',
      approverName: 'سارة',
    });
  });

  it('manager: sends the reason code and no approval', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const add = vi.fn().mockResolvedValue(OK);
    const { result } = renderHook(() => useSaleCartController({ bridge: bridgeWith(add) }));
    await act(async () => {
      await result.current.addDiscount({
        lineId: 'line-1',
        token: 'manual_amt_500',
        reasonCode: 'price_correction',
        approverName: 'سارة',
      });
    });
    expect(add.mock.calls[0]?.[0]).toMatchObject({ reason_code: 'price_correction' });
    expect(add.mock.calls[0]?.[0]).not.toHaveProperty('approval_id');
  });

  it('passes a refusal back and changes nothing; a failed transport is null', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const add = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'refused', reason: 'discount_already_applied' })
      .mockRejectedValueOnce(new Error('ipc'));
    const { result } = renderHook(() => useSaleCartController({ bridge: bridgeWith(add) }));
    const input = {
      lineId: 'line-1',
      token: 'manual_pct_10',
      reasonCode: 'promotion' as const,
      approverName: null,
    };
    let first: unknown;
    let second: unknown;
    await act(async () => {
      first = await result.current.addDiscount(input);
      second = await result.current.addDiscount(input);
    });
    expect(first).toEqual({ kind: 'refused', reason: 'discount_already_applied' });
    expect(second).toBeNull();
    expect(result.current.discountPlaceholders).toEqual([]);
  });

  it('sends nothing without an active cart', async () => {
    const add = vi.fn();
    const { result } = renderHook(() => useSaleCartController({ bridge: bridgeWith(add) }));
    let answer: unknown = 'unset';
    await act(async () => {
      answer = await result.current.addDiscount({
        lineId: 'line-1',
        token: 'manual_pct_10',
        reasonCode: 'promotion',
        approverName: null,
      });
    });
    expect(answer).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });

  it('reports a refused quantity change (line_discounted) to the Sale', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const bridge = bridgeWith(vi.fn());
    (bridge.lines.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'refused',
      reason: 'line_discounted',
    });
    const { result } = renderHook(() => useSaleCartController({ bridge }));
    let refused: unknown;
    await act(async () => {
      refused = await result.current.incrementLine('line-1', 1);
    });
    expect(refused).toBe('line_discounted');
  });
});

describe('a re-read cart keeps what the Sale knows about its discounts', () => {
  function snapshot(envelope: PaymentIntentEnvelope | null, state: CartState): CartSnapshot {
    return {
      cart_id: 'cart-1',
      state,
      lines: [
        {
          line_id: 'line-1',
          display_name: 'بنادول',
          quantity: 1,
          unit_price_minor: 1500,
          line_subtotal_minor: 1500,
          note: null,
          version: 2,
        },
      ],
      discount_placeholders: [{ placeholder_id: 'dp-1', line_id: 'line-1' }],
      paid: false,
      envelope,
    };
  }

  it('fills the token, reason and approver it remembered for that placeholder', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    useDiscountDetailsStore.getState().remember('dp-1', {
      token: 'manual_pct_10',
      reasonCode: 'promotion',
      approverName: 'سارة',
    });
    const read = vi
      .fn()
      .mockResolvedValue({ kind: 'ok', snapshot: snapshot(null, CartState.editing) });
    const hydrating = bridgeWith(vi.fn(), read);
    const { result } = renderHook(() =>
      useSaleCartController({ bridge: hydrating, hydrateActiveCart: true }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.discountPlaceholders).toEqual([
      {
        placeholderId: 'dp-1',
        lineId: 'line-1',
        attribution_operator_id: null,
        token: 'manual_pct_10',
        reasonCode: 'promotion',
        approverName: 'سارة',
      },
    ]);
  });

  it('takes the token from the frozen envelope when nothing was remembered', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    const envelope = {
      discount_placeholders: [
        {
          placeholder_id: 'dp-1',
          line_id: 'line-1',
          placeholder_kind: 'manual_amt_500',
          requires_manager_attribution: true,
          attribution_operator_id: null,
        },
      ],
    } as unknown as PaymentIntentEnvelope;
    const read = vi.fn().mockResolvedValue({
      kind: 'ok',
      snapshot: snapshot(envelope, CartState.frozen_handed_off),
    });
    const hydrating = bridgeWith(vi.fn(), read);
    const { result } = renderHook(() =>
      useSaleCartController({ bridge: hydrating, hydrateActiveCart: true }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.discountPlaceholders[0]).toMatchObject({
      token: 'manual_amt_500',
      reasonCode: null,
      approverName: null,
    });
  });

  it('forgets a removed discount', async () => {
    useCartStore.getState().applyCartCreated('cart-1');
    useDiscountDetailsStore.getState().remember('dp-1', {
      token: 'manual_pct_10',
      reasonCode: null,
      approverName: null,
    });
    const { result } = renderHook(() =>
      useSaleCartController({
        bridge: bridgeWith(vi.fn()),
        initialDiscountPlaceholders: [
          { placeholderId: 'dp-1', lineId: 'line-1', attribution_operator_id: null },
        ],
      }),
    );
    await act(async () => {
      await result.current.removeDiscount('dp-1');
    });
    expect(result.current.discountPlaceholders).toEqual([]);
    expect(useDiscountDetailsStore.getState().byPlaceholder).toEqual({});
    // Forgetting an unknown id is a no-op.
    useDiscountDetailsStore.getState().forget('dp-unknown');
    expect(useDiscountDetailsStore.getState().byPlaceholder).toEqual({});
  });
});
