/**
 * RT-1339 (RT-286 S7) — which offers apply to a cart, now (spec 048 §6, §7, §19).
 *
 * `planPromotions` is a pure projection over the cart's live lines and the Pack
 * view: it is recomputed from scratch on every read (§6 step 7), never stored on
 * a cart line, and the cashier never edits it. It runs the shared §6 evaluator
 * once per offer over that offer's own lines (the Pack's product sets are
 * disjoint, and `readOfferPack` makes them so).
 *
 * An offer applies only when ALL hold:
 *   • the view is `fresh` (age provable on the monotonic clock, within the window);
 *   • trusted "now" is at or after `startsAt` and before `endsAt`;
 *   • an `online_only` offer also has a successful read within the online proof;
 *   • the Pack's currency is the till's capture currency (`XXX` never matches);
 *   • the line has no manual discount (OD-5) and a whole quantity (always whole in
 *     the till's cart, F-9).
 *
 * Otherwise the offer is skipped. When a held Pack covers a cart line but cannot
 * be applied for want of proof (`unproven`, `stale`, or `online_only` offline), the
 * plan says `unavailable_offline` so the cart can show «العرض غير متاح بدون اتصال».
 */
import { evaluateOffer, type CartLine } from '../../shared/offers/offer-evaluator.js';
import { formatMinor } from '../../shared/offers/offer-decimal.js';
import {
  NO_PROMOTIONS,
  promotionTotalMinor,
  type PlanLine,
  type PromotionFact,
  type PromotionPreview,
} from '../../shared/offers/types.js';
import { knownExponentFor } from '../sales-sync/create-sale-sync-client.js';
import type { OfferPackView } from './offer-pack-service.js';
import type { OfferPack, PackOffer } from './offer-pack.js';

function coversALine(offer: PackOffer, lines: readonly PlanLine[]): boolean {
  return lines.some(
    (l) => !l.has_manual_discount && offer.eligibleProductIds.has(l.item_ref.toLowerCase()),
  );
}

function inWindow(offer: PackOffer, nowMs: number): boolean {
  return nowMs >= offer.startsAtMs && (offer.endsAtMs === null || nowMs < offer.endsAtMs);
}

function minorOf(text: string): number {
  return Number(text.replace('.', ''));
}

function factsOf(
  offer: PackOffer,
  pack: OfferPack,
  lines: readonly PlanLine[],
  exponent: number,
): PromotionFact[] {
  const eligible = lines.filter(
    (l) => !l.has_manual_discount && offer.eligibleProductIds.has(l.item_ref.toLowerCase()),
  );
  const cart: CartLine[] = eligible.map((l) => ({
    lineRef: l.line_id,
    productId: l.item_ref.toLowerCase(),
    unitPrice: formatMinor(BigInt(l.unit_price_minor), exponent),
    quantity: String(l.quantity),
    eligible: true,
  }));
  const evaluation = evaluateOffer({
    offer: offer.parameters,
    minorUnit: exponent,
    cart,
  });
  const taking = new Set(
    evaluation.lines.filter((l) => l.promotionDiscount !== null).map((l) => l.lineRef),
  );
  return eligible
    .filter((l) => taking.has(l.line_id))
    .map((l) => ({
      line_id: l.line_id,
      offer_id: offer.offerId,
      offer_version: offer.offerVersion,
      pack_revision: pack.packRevision,
      offer_name_ar: offer.nameAr,
      percent_off: Number(offer.parameters.percentOff),
      reward_discounts_minor: evaluation.rewards
        .filter((r) => r.lineRef === l.line_id)
        .map((r) => minorOf(r.discountAmount)),
    }));
}

/**
 * The offers that apply to `lines` under `view`. `currencyCode` is the till's
 * capture currency (what the sale's lines are priced in).
 */
export function planPromotions(
  lines: readonly PlanLine[],
  view: OfferPackView,
  currencyCode: string,
): PromotionPreview {
  if (view.kind === 'none' || lines.length === 0) return NO_PROMOTIONS;
  const { pack } = view;
  const exponent = knownExponentFor(pack.currencyCode);
  if (pack.currencyCode !== currencyCode || exponent === undefined) return NO_PROMOTIONS;
  if (view.kind !== 'fresh') {
    const covered = pack.offers.some((o) => coversALine(o, lines));
    return { ...NO_PROMOTIONS, unavailable_offline: covered };
  }
  const facts: PromotionFact[] = [];
  let unavailable = false;
  for (const offer of pack.offers) {
    if (!coversALine(offer, lines) || !inWindow(offer, view.nowMs)) continue;
    if (offer.offlinePolicy === 'online_only' && !view.onlineProven) {
      unavailable = true;
      continue;
    }
    facts.push(...factsOf(offer, pack, lines, exponent));
  }
  return {
    promotions: facts,
    promotion_total_minor: promotionTotalMinor(facts),
    unavailable_offline: unavailable,
  };
}
