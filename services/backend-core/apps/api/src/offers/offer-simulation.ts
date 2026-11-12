/**
 * The preview simulation (spec 048 §10 "cart of these prices → result"):
 * the draft's parameters and the §6 evaluator over a list of unit prices.
 * A line without `productId` is an eligible unit price; a line with one is
 * eligible when the product is in the draft's eligible set. Lines are taken in
 * the order sent, which breaks price ties (§6 step 2).
 */
import { minorUnitExponent } from "../catalog/sales/iso4217-minor-units";
import { OfferDecimalError } from "./evaluator/offer-decimal";
import { evaluateOffer, type CartLine, type EvaluatorOffer } from "./evaluator/offer-evaluator";
import { OfferRefusedError } from "./offer-errors";
import type { OfferPreviewBody } from "./offers.dto";

export interface SimulationResultBody {
  readonly currencyCode: string;
  readonly applications: number;
  readonly totalDiscount: string;
  readonly total: string;
  readonly lines: ReadonlyArray<{
    readonly lineIndex: number;
    readonly unitPrice: string;
    readonly quantity: number;
    readonly eligible: boolean;
    readonly discountAmount: string;
    readonly lineAmount: string;
  }>;
}

export function simulateOffer(
  simulation: NonNullable<OfferPreviewBody["simulation"]>,
  offer: EvaluatorOffer,
  eligibleProductIds: ReadonlySet<string>,
): SimulationResultBody {
  const minorUnit = minorUnitExponent(simulation.currencyCode);
  // A currency with no minor unit cannot be priced; the price must also fit the minor unit.
  if (minorUnit === null) throw new OfferRefusedError("validation_error");
  const cart: CartLine[] = simulation.lines.map((l, i) => ({
    lineRef: String(i),
    productId: l.productId ?? "",
    unitPrice: l.unitPrice,
    quantity: String(l.quantity ?? 1),
    eligible: l.productId === undefined ? true : eligibleProductIds.has(l.productId),
  }));
  let evaluation;
  try {
    evaluation = evaluateOffer({ offer, minorUnit, cart });
  } catch (err) {
    if (err instanceof OfferDecimalError) throw new OfferRefusedError("validation_error");
    throw err;
  }
  const eligibleRefs = new Set(cart.filter((c) => c.eligible).map((c) => c.lineRef));
  const zero = (0).toFixed(minorUnit);
  return {
    currencyCode: simulation.currencyCode,
    applications: evaluation.applications,
    totalDiscount: evaluation.totalDiscount,
    total: evaluation.total,
    lines: evaluation.lines.map((l) => ({
      lineIndex: Number(l.lineRef),
      unitPrice: l.unitPrice,
      quantity: Number(l.quantity),
      eligible: eligibleRefs.has(l.lineRef),
      discountAmount: l.promotionDiscount ?? zero,
      lineAmount: l.lineAmount,
    })),
  };
}
