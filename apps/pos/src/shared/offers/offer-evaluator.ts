/**
 * RT-1339 (RT-286 S7) — the POS Offer Engine evaluator, spec 048 §6.
 *
 * `evaluateOffer(input)` is PURE and deterministic: its inputs are the cart and
 * one offer version's parameters. It reads no clock, no network and no catalog
 * (OD-6: eligibility arrives as a flag per line, resolved from the Pack's
 * materialised eligible set). It is the same algorithm as Backend-Core's
 * `offers/evaluator/offer-evaluator.ts`, and both are proven against the same
 * golden vectors (`__tests__/offers-golden-vectors.json`).
 *
 *   1. Eligible units: every eligible line expands into quantity-1 units. A
 *      line with a manual discount (OD-5) or a non-whole quantity (F-9) never
 *      takes part.
 *   2. Order: unit price, highest first; ties by cart line order, then by
 *      product id, so the order is total.
 *   3. Applications: k = floor(n / (X + Y)), capped at maxApplicationsPerSale.
 *   4. Rewards (OD-2): the last k × Y units of that order.
 *   5. Discount of a reward unit: P% of its unit price, half up once at the
 *      currency minor unit (OD-28-3).
 *   6. Split (OD-4): each reward unit becomes its own quantity-1 line after
 *      the rest of its source line.
 */
import {
  formatMinor,
  grossMinor,
  OfferDecimalError,
  percentOf,
  scaled,
  wholeUnits,
} from './offer-decimal.js';

/** The parameters of one `buy_x_get_y_percent` version that the evaluation uses. */
export interface EvaluatorOffer {
  readonly buyQuantity: number;
  readonly getQuantity: number;
  /** A whole percent "1".."100". */
  readonly percentOff: string;
  /** Null: unlimited. */
  readonly maxApplicationsPerSale: number | null;
}

export interface CartLine {
  /** Opaque identity of the line, echoed on the output lines. */
  readonly lineRef: string;
  readonly productId: string;
  readonly unitPrice: string;
  readonly quantity: string;
  /** True when the product is in the offer's materialised eligible set. */
  readonly eligible: boolean;
  /** Present when the line carries a manual discount (OD-5: it never takes part). */
  readonly manualDiscount?: { readonly amount: string } | undefined;
}

interface EvaluatedLine {
  readonly lineRef: string;
  readonly productId: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly lineAmount: string;
  /** The `promotion.discountAmount`, or null when the line carries no promotion. */
  readonly promotionDiscount: string | null;
}

export interface Evaluation {
  readonly applications: number;
  readonly rewards: ReadonlyArray<{ lineRef: string; unitPrice: string; discountAmount: string }>;
  readonly totalDiscount: string;
  readonly total: string;
  readonly lines: ReadonlyArray<EvaluatedLine>;
}

export interface EvaluateInput {
  readonly offer: EvaluatorOffer;
  readonly minorUnit: number;
  readonly cart: ReadonlyArray<CartLine>;
}

export interface OfferUnit {
  readonly price: bigint;
  readonly order: number;
  readonly productId: string;
}

/** Step 2 order: price high to low, then cart line order, then product id. */
function compareUnits(a: OfferUnit, b: OfferUnit): number {
  if (a.price !== b.price) return a.price > b.price ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  if (a.productId === b.productId) return 0;
  return a.productId < b.productId ? -1 : 1;
}

/** Steps 3 and 4: the number of applications and the reward units (OD-2). */
function pickRewards(
  units: ReadonlyArray<OfferUnit>,
  offer: EvaluatorOffer,
): { applications: number; rewards: OfferUnit[] } {
  const ordered = [...units].sort(compareUnits);
  let applications = Math.floor(ordered.length / (offer.buyQuantity + offer.getQuantity));
  if (offer.maxApplicationsPerSale !== null) {
    applications = Math.min(applications, offer.maxApplicationsPerSale);
  }
  const rewardCount = applications * offer.getQuantity;
  return {
    applications,
    rewards: rewardCount === 0 ? [] : ordered.slice(ordered.length - rewardCount),
  };
}

/** The reward units' total discount over a set of eligible units (the §9 `D_remaining`). */
export function totalDiscountOf(units: ReadonlyArray<OfferUnit>, offer: EvaluatorOffer): bigint {
  return pickRewards(units, offer).rewards.reduce(
    (sum, r) => sum + percentOf(r.price, offer.percentOff),
    0n,
  );
}

/** The most units one evaluation expands. Far above any retail basket. */
export const MAX_EVALUATED_UNITS = 100_000n;

function expandUnits(input: EvaluateInput): OfferUnit[] {
  const { minorUnit, cart } = input;
  let evaluatedUnits = 0n;
  return cart.flatMap((line, order) => {
    const whole = wholeUnits(line.quantity);
    if (!line.eligible || line.manualDiscount !== undefined || whole === null) return [];
    evaluatedUnits += whole;
    // Units are expanded one by one (spec §6); a bound keeps a hostile quantity from exhausting the process.
    if (evaluatedUnits > MAX_EVALUATED_UNITS) {
      throw new OfferDecimalError(line.quantity, 0, 'too many units in one evaluation');
    }
    const price = scaled(line.unitPrice, minorUnit);
    return Array.from({ length: Number(whole) }, () => ({
      price,
      order,
      productId: line.productId,
    }));
  });
}

function rewardDiscountsByLine(
  rewards: ReadonlyArray<OfferUnit>,
  offer: EvaluatorOffer,
): Map<number, bigint[]> {
  const perLine = new Map<number, bigint[]>();
  for (const r of rewards) {
    const discounts = perLine.get(r.order) ?? [];
    discounts.push(percentOf(r.price, offer.percentOff));
    perLine.set(r.order, discounts);
  }
  return perLine;
}

function untouchedLine(line: CartLine, minorUnit: number): EvaluatedLine {
  const manual = line.manualDiscount ? scaled(line.manualDiscount.amount, minorUnit) : 0n;
  return {
    lineRef: line.lineRef,
    productId: line.productId,
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    lineAmount: formatMinor(
      grossMinor(line.unitPrice, line.quantity, minorUnit) - manual,
      minorUnit,
    ),
    promotionDiscount: null,
  };
}

function splitLine(
  line: CartLine,
  discounts: readonly bigint[],
  minorUnit: number,
): EvaluatedLine[] {
  const price = scaled(line.unitPrice, minorUnit);
  const base = { lineRef: line.lineRef, productId: line.productId, unitPrice: line.unitPrice };
  const whole = wholeUnits(line.quantity) ?? 0n;
  const rest = whole - BigInt(discounts.length);
  const restLine: EvaluatedLine[] =
    rest > 0n
      ? [
          {
            ...base,
            quantity: rest.toString(),
            lineAmount: formatMinor(price * rest, minorUnit),
            promotionDiscount: formatMinor(0n, minorUnit),
          },
        ]
      : [];
  return [
    ...restLine,
    ...discounts.map((d) => ({
      ...base,
      quantity: '1',
      lineAmount: formatMinor(price - d, minorUnit),
      promotionDiscount: formatMinor(d, minorUnit),
    })),
  ];
}

/** Spec 048 §6 steps 1–6 over one cart. */
export function evaluateOffer(input: EvaluateInput): Evaluation {
  const { offer, minorUnit, cart } = input;
  const units = expandUnits(input);
  const { applications, rewards } = pickRewards(units, offer);
  const participating = new Set(units.map((u) => u.order));
  const perLine = rewardDiscountsByLine(rewards, offer);

  const lines = cart.flatMap((line, order): EvaluatedLine[] =>
    applications === 0 || !participating.has(order)
      ? [untouchedLine(line, minorUnit)]
      : splitLine(line, perLine.get(order) ?? [], minorUnit),
  );
  const totalDiscount = rewards.reduce((sum, r) => sum + percentOf(r.price, offer.percentOff), 0n);
  return {
    applications,
    rewards: rewards.map((r) => ({
      lineRef: cart[r.order]?.lineRef ?? '',
      unitPrice: cart[r.order]?.unitPrice ?? '',
      discountAmount: formatMinor(percentOf(r.price, offer.percentOff), minorUnit),
    })),
    totalDiscount: formatMinor(totalDiscount, minorUnit),
    total: formatMinor(
      lines.reduce((sum, l) => sum + scaled(l.lineAmount, minorUnit), 0n),
      minorUnit,
    ),
    lines,
  };
}
