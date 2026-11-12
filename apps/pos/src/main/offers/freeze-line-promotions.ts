/**
 * RT-1339 (RT-286 S7) — freeze each automatic offer onto the Sale's line
 * snapshot at finalize (spec 048 §6 step 6 line split, §8 frozen facts).
 *
 * Source: the handoff envelope's `promotions` (the plan frozen at handoff, so the
 * Pack and the clock of that moment decide the sale, never the later finalize
 * moment or the sync). For a cart line with an offer fact:
 *
 *   • the line keeps its `line_id` for the units that are not rewards (omitted
 *     when every unit is a reward) and carries `promotion.discount_minor` 0;
 *   • each reward unit becomes its own quantity-1 line (OD-4), with a line id
 *     derived deterministically from the source line and the unit index, and
 *     `promotion.discount_minor` the unit's discount.
 *
 * `line_subtotal_minor` stays the line's GROSS (`unit × quantity`), as for a manual
 * discount (RT-856); the net is gross − discount. Nothing is read from a clock, the
 * Pack or the database, so a re-run builds the same snapshot byte for byte (RT-1240).
 *
 * Fail closed. A fact on a line with a manual discount (OD-5), two facts on one
 * line, more reward units than the line holds, a discount above a unit price, or a
 * settled amount that is not Σ net: `promotion_mismatch`. The dispatch refuses
 * rather than write a sale whose lines do not add up to what the customer paid.
 */
import { createHash } from 'node:crypto';
import type { PromotionFact, SaleLinePromotion } from '../../shared/offers/types.js';
import type { SaleLineSnapshot as PromotedSaleLine } from '../sales/freeze-line-discounts.js';

export type FreezePromotionsResult =
  | { kind: 'ok'; lines: readonly PromotedSaleLine[] }
  | { kind: 'refused'; reason: 'promotion_mismatch' };

const REFUSED: FreezePromotionsResult = { kind: 'refused', reason: 'promotion_mismatch' };

/**
 * A deterministic UUID-shaped id for reward unit `index` (1-based) of a source
 * line: SHA-256 of a fixed label, shaped 8-4-4-4-12 with version nibble 8
 * (custom) and the RFC 4122 variant. Backend-Core's `lineRef` accepts any UUID.
 */
export function rewardLineId(sourceLineId: string, index: number): string {
  const hex = createHash('sha256')
    .update(`rt1339:reward:${sourceLineId}:${String(index)}`)
    .digest('hex');
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function promotionOf(fact: PromotionFact, discount_minor: number): SaleLinePromotion {
  return {
    offer_id: fact.offer_id,
    offer_version: fact.offer_version,
    pack_revision: fact.pack_revision,
    offer_name_ar: fact.offer_name_ar,
    percent_off: fact.percent_off,
    discount_minor,
  };
}

function isNonNegativeSafe(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/** The source line split into its rest line and reward lines, or null when the fact does not fit it. */
function splitLine(line: PromotedSaleLine, fact: PromotionFact): PromotedSaleLine[] | null {
  const rewards = fact.reward_discounts_minor;
  const unit = line.unit_price_minor;
  if (line.discount !== undefined || rewards.length > line.quantity) return null;
  if (!rewards.every((d) => isNonNegativeSafe(d) && d <= unit)) return null;
  const rest = line.quantity - rewards.length;
  const restLine: PromotedSaleLine[] =
    rest > 0
      ? [
          {
            ...line,
            quantity: rest,
            line_subtotal_minor: unit * rest,
            promotion: promotionOf(fact, 0),
          },
        ]
      : [];
  return [
    ...restLine,
    ...rewards.map((d, i) => ({
      ...line,
      line_id: rewardLineId(line.line_id, i + 1),
      quantity: 1,
      line_subtotal_minor: unit,
      promotion: promotionOf(fact, d),
    })),
  ];
}

function netOf(line: PromotedSaleLine): number {
  return (
    line.line_subtotal_minor -
    (line.discount?.amount_minor ?? 0) -
    (line.promotion?.discount_minor ?? 0)
  );
}

/** The sale's lines with every offer fact frozen on, split as §6 step 6 says, or a refusal. */
export function freezeLinePromotions(
  lines: readonly PromotedSaleLine[],
  promotions: readonly PromotionFact[],
  amountDueMinor: number,
): FreezePromotionsResult {
  if (promotions.length === 0) return { kind: 'ok', lines };
  const byLine = new Map<string, PromotionFact>();
  for (const fact of promotions) {
    if (byLine.has(fact.line_id)) return REFUSED;
    byLine.set(fact.line_id, fact);
  }
  const frozen: PromotedSaleLine[] = [];
  for (const line of lines) {
    const fact = byLine.get(line.line_id);
    const pieces = fact === undefined ? [line] : splitLine(line, fact);
    if (pieces === null) return REFUSED;
    frozen.push(...pieces);
  }
  // Every fact must have found its line; a fact for a removed line is not the settled sale.
  const lineIds = new Set(lines.map((l) => l.line_id));
  if (![...byLine.keys()].every((id) => lineIds.has(id))) return REFUSED;
  const net = frozen.reduce((sum, l) => sum + netOf(l), 0);
  return net === amountDueMinor ? { kind: 'ok', lines: frozen } : REFUSED;
}
