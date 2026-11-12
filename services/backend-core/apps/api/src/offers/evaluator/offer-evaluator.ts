/**
 * The Offer Engine evaluator — spec 048 §6 (Jira RT-1337, RT-286 S4).
 *
 * `evaluateOffer(cart, offer)` is PURE and deterministic: its inputs are the
 * cart and the offer version's parameters, and it reads no clock, no network
 * and no catalog (OD-6: eligibility arrives as a flag per line, resolved from
 * the materialised eligible set). It is shared by the preview simulation and
 * by capture's server-side re-evaluation (OD-9), and is proven against the
 * golden vectors in `packages/contracts/fixtures/offers/golden-vectors.json`.
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
import { formatMinor, grossMinor, OfferDecimalError, percentOf, scaled, wholeUnits } from "./offer-decimal";

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
  /** True when the line carries a manual discount (OD-5: it never takes part). */
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

interface Unit {
  readonly price: bigint;
  readonly order: number;
  readonly productId: string;
}

/** Step 2 order: price high to low, then cart line order, then product id. */
function compareUnits(a: Unit, b: Unit): number {
  if (a.price !== b.price) return a.price > b.price ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
}

/** Steps 3 and 4: the number of applications and the reward units (OD-2). */
function pickRewards(
  units: ReadonlyArray<Unit>,
  offer: EvaluatorOffer,
): { applications: number; rewards: Unit[] } {
  const ordered = [...units].sort(compareUnits);
  let applications = Math.floor(ordered.length / (offer.buyQuantity + offer.getQuantity));
  if (offer.maxApplicationsPerSale !== null) applications = Math.min(applications, offer.maxApplicationsPerSale);
  const rewardCount = applications * offer.getQuantity;
  return { applications, rewards: rewardCount === 0 ? [] : ordered.slice(ordered.length - rewardCount) };
}

/** The reward units' total discount over a set of eligible units (used by the §9 `D_remaining`). */
export function totalDiscountOf(
  units: ReadonlyArray<{ readonly price: bigint; readonly order: number; readonly productId: string }>,
  offer: EvaluatorOffer,
): bigint {
  return pickRewards(units, offer).rewards.reduce((sum, r) => sum + percentOf(r.price, offer.percentOff), 0n);
}

/** The most units one evaluation expands. Far above any retail basket; a larger quantity is refused as arithmetic. */
export const MAX_EVALUATED_UNITS = 100_000n;

/** Spec 048 §6 steps 1–6 over one cart. */
export function evaluateOffer(input: EvaluateInput): Evaluation {
  const { offer, minorUnit, cart } = input;
  let evaluatedUnits = 0n;
  const units: Unit[] = cart.flatMap((line, order) => {
    const whole = wholeUnits(line.quantity);
    if (!line.eligible || line.manualDiscount !== undefined || whole === null) return [];
    evaluatedUnits += whole;
    // Units are expanded one by one (spec §6); a bound keeps a hostile quantity from exhausting the process.
    if (evaluatedUnits > MAX_EVALUATED_UNITS) throw new OfferDecimalError(line.quantity, 0, `more than ${MAX_EVALUATED_UNITS} units in one evaluation`);
    const price = scaled(line.unitPrice, minorUnit);
    return Array.from({ length: Number(whole) }, () => ({ price, order, productId: line.productId }));
  });
  const { applications, rewards } = pickRewards(units, offer);
  const participating = new Set(units.map((u) => u.order));
  const perLine = new Map<number, bigint[]>();
  for (const r of rewards) perLine.set(r.order, [...(perLine.get(r.order) ?? []), percentOf(r.price, offer.percentOff)]);

  const lines: EvaluatedLine[] = cart.flatMap((line, order): EvaluatedLine[] => {
    const price = scaled(line.unitPrice, minorUnit);
    const base = { lineRef: line.lineRef, productId: line.productId, unitPrice: line.unitPrice };
    if (applications === 0 || !participating.has(order)) {
      const manual = line.manualDiscount ? scaled(line.manualDiscount.amount, minorUnit) : 0n;
      return [
        {
          ...base,
          quantity: line.quantity,
          lineAmount: formatMinor(grossMinor(line.unitPrice, line.quantity, minorUnit) - manual, minorUnit),
          promotionDiscount: null,
        },
      ];
    }
    const discounts = perLine.get(order) ?? [];
    const rest = wholeUnits(line.quantity)! - BigInt(discounts.length);
    return [
      ...(rest > 0n
        ? [
            {
              ...base,
              quantity: rest.toString(),
              lineAmount: formatMinor(price * rest, minorUnit),
              promotionDiscount: formatMinor(0n, minorUnit),
            },
          ]
        : []),
      ...discounts.map((d) => ({
        ...base,
        quantity: "1",
        lineAmount: formatMinor(price - d, minorUnit),
        promotionDiscount: formatMinor(d, minorUnit),
      })),
    ];
  });
  const totalDiscount = rewards.reduce((sum, r) => sum + percentOf(r.price, offer.percentOff), 0n);
  return {
    applications,
    rewards: rewards.map((r) => ({
      lineRef: cart[r.order]!.lineRef,
      unitPrice: cart[r.order]!.unitPrice,
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
