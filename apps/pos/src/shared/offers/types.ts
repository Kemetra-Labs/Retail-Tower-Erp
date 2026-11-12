/**
 * RT-1339 (RT-286 S7) — the automatic-offer facts the till carries from the cart
 * handoff to the sale, the receipt and the capture, and their shared copy.
 *
 * Money is integer minor units. A `PromotionFact` is the frozen result of
 * evaluating one offer version over one cart line (spec 048 §6): the offer's
 * identity as the Pack gave it (`offer_id`, `offer_version`, `pack_revision`),
 * the offer's Arabic name and percent (kept so a reprint never depends on the
 * current Pack), and one discount per reward unit.
 */

export interface PromotionFact {
  /** The cart line the offer was evaluated on; its `line_id`. */
  readonly line_id: string;
  readonly offer_id: string;
  readonly offer_version: number;
  readonly pack_revision: number;
  readonly offer_name_ar: string;
  /** The offer's whole percent off (1–100), for the receipt copy. */
  readonly percent_off: number;
  /**
   * One entry per reward unit of this line, in minor units (may be 0 for a very
   * small price). Empty: the line takes part (counts toward the offer) but has no
   * reward unit.
   */
  readonly reward_discounts_minor: readonly number[];
}

/** The `promotion` frozen on a sale line (`sales.lines_json`) and sent in capture. */
export interface SaleLinePromotion {
  readonly offer_id: string;
  readonly offer_version: number;
  readonly pack_revision: number;
  readonly offer_name_ar: string;
  readonly percent_off: number;
  /** 0 on a participating line that is not a reward. */
  readonly discount_minor: number;
}

/** Cashier-facing line copy under a reward line: «عرض: <offer> (خصم 40%)». */
export function promotionCopy(offerNameAr: string, percentOff: number): string {
  return `عرض: ${offerNameAr} (خصم ${String(percentOff)}%)`;
}

/** Shown when a stored Pack covers a cart line but its freshness cannot be proven. */
export const OFFER_UNAVAILABLE_OFFLINE_AR = 'العرض غير متاح بدون اتصال';

/** The cart line facts the offer plan reads. `quantity` and prices are integer minor units. */
export interface PlanLine {
  readonly line_id: string;
  readonly item_ref: string;
  readonly quantity: number;
  readonly unit_price_minor: number;
  /** The line carries a manual discount placeholder (OD-5: it never takes part). */
  readonly has_manual_discount: boolean;
}

/** What the cart view needs of the offers: the facts, the total and the offline notice. */
export interface PromotionPreview {
  readonly promotions: readonly PromotionFact[];
  readonly promotion_total_minor: number;
  /** True when a stored offer covers a cart line but cannot be applied offline (restart or stale). */
  readonly unavailable_offline: boolean;
}

/** The plan of a cart with no applicable offer. */
export const NO_PROMOTIONS: PromotionPreview = {
  promotions: [],
  promotion_total_minor: 0,
  unavailable_offline: false,
};
