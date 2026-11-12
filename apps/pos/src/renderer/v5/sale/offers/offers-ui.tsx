import { useEffect, useRef, useState, type JSX } from 'react';

import type { CartBridgeAPI } from '../../../../shared/bridge-api';
import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope';
import { CartState } from '../../../../shared/cart/cart-state';
import { useCartStore } from '../../../stores/cart-store';
import { windowCartBridge } from '../../park/park-bridge';
import {
  OFFER_UNAVAILABLE_OFFLINE_AR,
  promotionCopy,
  type PromotionFact,
  type PromotionPreview,
} from '../../../../shared/offers/types';
import { DiscountAmount } from '../discount/DiscountParts';

/**
 * RT-1339 (RT-286 S7) — the automatic offers as the cart shows them. Main evaluates the Offer
 * Pack (`cart.promotionPreview`); the renderer only shows the result, and never computes,
 * edits or removes an offer (spec 048 §6 step 7: the cashier never edits a promotion discount).
 */

/** Copy of the cart's offer figures: the row copy itself is `promotionCopy` (shared with the receipt). */
export const OFFER_COPY = Object.freeze({
  totalOffers: 'خصم العروض',
  unavailableOffline: OFFER_UNAVAILABLE_OFFLINE_AR,
});

/** One cart line's reward units, as the cart shows them. */
export interface LinePromotionView {
  readonly offerNameAr: string;
  readonly percentOff: number;
  /** How many units of the line take the reward (each is its own sale line, OD-4). */
  readonly rewardUnits: number;
  readonly amountMinor: number;
}

/** The lines that have at least one reward unit, by line id. */
export function promotionViewsByLine(
  facts: readonly PromotionFact[],
): ReadonlyMap<string, LinePromotionView> {
  const byLine = new Map<string, LinePromotionView>();
  for (const fact of facts) {
    if (fact.reward_discounts_minor.length === 0) continue;
    byLine.set(fact.line_id, {
      offerNameAr: fact.offer_name_ar,
      percentOff: fact.percent_off,
      rewardUnits: fact.reward_discounts_minor.length,
      amountMinor: fact.reward_discounts_minor.reduce((sum, d) => sum + d, 0),
    });
  }
  return byLine;
}

/**
 * The row under a reward line: «عرض: <offer> (خصم 40%)», the reward units when more than one,
 * and the discount in the line-total column. Read only: no control.
 */
export function LinePromotionRow({
  promotion,
}: Readonly<{ promotion: LinePromotionView }>): JSX.Element {
  return (
    <div className="v5-discount-row v5-promo-row" data-testid="line-promotion">
      <span className="v5-discount-what">
        <bdi>{promotionCopy(promotion.offerNameAr, promotion.percentOff)}</bdi>
        {promotion.rewardUnits > 1 && (
          <span className="v5-discount-meta">
            <bdi dir="ltr">{`×${String(promotion.rewardUnits)}`}</bdi>
          </span>
        )}
      </span>
      <DiscountAmount minor={promotion.amountMinor} className="v5-discount-amount" />
    </div>
  );
}

/** A cart's lines and manual discounts, as one string that changes on any material cart change. */
export function cartSignature(
  lines: ReadonlyArray<{ lineId: string; quantity: number; unitPriceMinor: number }>,
  discountLineIds: ReadonlyArray<string | null | undefined>,
): string {
  const parts = lines.map((l) => `${l.lineId}:${String(l.quantity)}:${String(l.unitPriceMinor)}`);
  return `${parts.join('|')}#${discountLineIds.filter((id) => id != null).join('|')}`;
}

/** Ask again this often, so an offer's start or end, and the Pack's age, show without a cart change. */
const PREVIEW_REFRESH_MS = 60_000;

/**
 * The offers the editing cart earns now. Asks main after every material cart change (the
 * `signature`) and on a timer; a stale answer is dropped. `null` until the first answer, and
 * `null` again when the cart is not editing or main cannot answer: the cart then shows no offer.
 */
export function usePromotionPreview(input: {
  bridge: CartBridgeAPI | null;
  cartId: string | null;
  enabled: boolean;
  signature: string;
}): PromotionPreview | null {
  const { bridge, cartId, enabled, signature } = input;
  const [preview, setPreview] = useState<PromotionPreview | null>(null);
  const askId = useRef(0);

  useEffect(() => {
    if (!enabled || cartId === null || typeof bridge?.promotionPreview !== 'function') {
      askId.current += 1;
      setPreview(null);
      return undefined;
    }
    const run = (): void => {
      const mine = ++askId.current;
      void bridge
        .promotionPreview?.({ cart_id: cartId })
        .then((answer) => {
          if (askId.current === mine) setPreview(answer.kind === 'ok' ? answer.preview : null);
        })
        .catch(() => {
          if (askId.current === mine) setPreview(null);
        });
    };
    run();
    const timer = setInterval(run, PREVIEW_REFRESH_MS);
    return () => {
      askId.current += 1;
      clearInterval(timer);
    };
  }, [bridge, cartId, enabled, signature]);

  return preview;
}

/** What `LiveSaleCart` takes of the offers: the live preview, or the frozen envelope's facts. */
interface CartOfferProps {
  promotions: PromotionPreview | null;
  frozenPromotions?: NonNullable<PaymentIntentEnvelope['promotions']>;
  frozenPromotionMinor?: number;
}

/** The cart the sale screen shows, as far as the offers read it. */
interface OfferCart {
  readonly lines: ReadonlyArray<{ lineId: string; quantity: number; unitPriceMinor: number }>;
  readonly discountPlaceholders: ReadonlyArray<{ lineId?: string | null }>;
  readonly envelope: PaymentIntentEnvelope | null;
}

/**
 * The offers for the cart on screen (main evaluates; this only shows them): asks main while the
 * cart is editing, after every material change, and once the cart is frozen reads the facts main
 * froze into its envelope.
 */
export function useCartOffers(
  cart: OfferCart,
  bridge: CartBridgeAPI | undefined,
  paid: boolean,
): CartOfferProps {
  const cartId = useCartStore((state) => state.activeCart?.cart_id ?? null);
  const cartState = useCartStore((state) => state.activeCart?.state ?? null);
  const promotions = usePromotionPreview({
    bridge: bridge ?? windowCartBridge(),
    cartId,
    enabled: cartState === CartState.editing && !paid && cart.lines.length > 0,
    signature: cartSignature(
      cart.lines,
      cart.discountPlaceholders.map((d) => d.lineId),
    ),
  });
  const envelope = cartState === CartState.frozen_handed_off ? cart.envelope : null;
  if (envelope?.promotions === undefined) return { promotions };
  return {
    promotions,
    frozenPromotions: envelope.promotions,
    frozenPromotionMinor: envelope.promotion_total_minor ?? 0,
  };
}
