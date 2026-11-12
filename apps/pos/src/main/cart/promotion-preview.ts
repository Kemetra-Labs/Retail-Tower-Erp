/**
 * RT-1339 (RT-286 S7) — what the cashier's cart shows of the automatic offers.
 *
 * A pure projection of the cart's live lines and discount placeholders through the
 * offer plan, recomputed on every ask (spec 048 §6 step 7): nothing is stored on a
 * cart line and the cashier never edits it. The same `planLinesOf` the handoff
 * uses decides which lines take part, so what the cart shows is what the handoff
 * freezes (unless the clock or the Pack moved in between, in which case the handoff
 * is the truth and the next ask shows it).
 */
import type { PlanLine, PromotionPreview } from '../../shared/offers/types.js';
import { NO_PROMOTIONS } from '../../shared/offers/types.js';
import type { CartStore } from './cart-store.js';
import { planLinesOf } from './handoff-envelope-builder.js';

export type PlanPromotions = (lines: readonly PlanLine[]) => PromotionPreview;

/** The offers for a cart's live lines; none when no planner is wired or the cart is empty. */
export function previewCartPromotions(
  store: CartStore,
  cart_id: string,
  plan: PlanPromotions | undefined,
): PromotionPreview {
  if (plan === undefined) return NO_PROMOTIONS;
  const lines = store.getActiveLines(cart_id);
  if (lines.length === 0) return NO_PROMOTIONS;
  const placeholders = store.getDiscountPlaceholdersForCart(cart_id);
  return plan(planLinesOf(lines, placeholders));
}
