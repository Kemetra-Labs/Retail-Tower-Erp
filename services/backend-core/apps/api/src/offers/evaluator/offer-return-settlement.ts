/**
 * Return clawback — spec 048 §9, multi-return form (Jira RT-1337, RT-286 S4;
 * the rule of `pos-sales/sales.yaml` `recordReturn`). PURE.
 *
 * A return uses the FROZEN offer version and unit prices of the sale (never
 * the current offers). For one offer version O of the sale, counting every
 * earlier return of the sale:
 *
 *   D_held      = Σ discountAmount of the O units not returned before
 *                 − the OUTSTANDING clawback of O: the clawbacks recorded on earlier
 *                   returns net of the give-backs those returns made
 *                   (`offer-return-history.ts`)
 *   disc_ret    = min( Σ discountAmount of the O units returned now, D_held )
 *   D_remaining = evaluate(the O units the customer still keeps after this
 *                 return, O's frozen parameters and prices).totalDiscount
 *   refund_O    = Σ gross of the returned O units − max( disc_ret, D_held − D_remaining )
 *   clawback_O  = max( 0, D_held − D_remaining − disc_ret )
 *
 * `giveBack` is the part of the refund that returns a discount an EARLIER
 * return clawed back: Σ discountAmount of the units returned now − disc_ret.
 * It is zero unless an earlier clawback exists. The recorded facts (a
 * clawback row has `amount > 0`) and `returnTotal` = Σ lineAmount − Σ clawback
 * cannot carry a give-back, so the service refuses such a return (fail
 * closed); the arithmetic is kept here because the golden sequence S3 pins it.
 */
import { MAX_EVALUATED_UNITS, totalDiscountOf, type EvaluatorOffer } from "./offer-evaluator";
import { scaled, wholeUnits } from "./offer-decimal";

/** One sale line that cites offer version O (its `promotion` fact), as frozen at capture. */
export interface SaleOfferLine {
  readonly lineRef: string;
  readonly productId: string;
  readonly unitPrice: string;
  readonly quantity: string;
  /** The line's frozen net. */
  readonly lineAmount: string;
  /** `promotion.discountAmount` ("0.00" on an eligible line that is not a reward). */
  readonly discountAmount: string;
}

export interface ReturnSettlementInput {
  readonly offer: EvaluatorOffer;
  readonly minorUnit: number;
  /** Every line of the sale that cites this offer version, in sale line order. */
  readonly saleLines: ReadonlyArray<SaleOfferLine>;
  /** Units returned per `lineRef` by EARLIER returns of the sale. */
  readonly returnedBefore: ReadonlyMap<string, bigint>;
  /** The outstanding clawback of this offer version: recorded clawbacks net of earlier give-backs (minor units). */
  readonly clawbacksBefore: bigint;
  /** Units returned now per `lineRef` (O lines only). */
  readonly returnedNow: ReadonlyMap<string, bigint>;
}

export interface ReturnSettlement {
  readonly dHeld: bigint;
  readonly discReturned: bigint;
  readonly dRemaining: bigint;
  readonly netReturned: bigint;
  readonly grossReturned: bigint;
  /** May be negative: the OD-10 refusal. */
  readonly refund: bigint;
  /** Null when `refund` is negative (the return is refused, so no clawback is recorded). */
  readonly clawback: bigint | null;
  readonly giveBack: bigint;
}

/** A promoted sale line breaks an invariant the capture guard enforces (never reachable from valid data). */
class OfferReturnInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferReturnInvariantError";
  }
}

export function settleOfferReturn(input: ReturnSettlementInput): ReturnSettlement {
  const { offer, minorUnit, saleLines, returnedBefore, clawbacksBefore, returnedNow } = input;
  let held = 0n;
  let discNow = 0n;
  let net = 0n;
  let gross = 0n;
  const kept: Array<{ price: bigint; order: number; productId: string }> = [];
  saleLines.forEach((line, order) => {
    const sold = wholeUnits(line.quantity);
    if (sold === null || sold === 0n) throw new OfferReturnInvariantError(`line ${line.lineRef} has a non-whole quantity`);
    const discount = scaled(line.discountAmount, minorUnit);
    if (discount % sold !== 0n) throw new OfferReturnInvariantError(`line ${line.lineRef} discount does not divide by its quantity`);
    const unitDiscount = discount / sold;
    const before = returnedBefore.get(line.lineRef) ?? 0n;
    const now = returnedNow.get(line.lineRef) ?? 0n;
    const price = scaled(line.unitPrice, minorUnit);
    held += unitDiscount * (sold - before);
    discNow += unitDiscount * now;
    gross += price * now;
    const lineAmount = scaled(line.lineAmount, minorUnit);
    if ((lineAmount * now) % sold !== 0n) throw new OfferReturnInvariantError(`line ${line.lineRef} net does not divide by its quantity`);
    net += (lineAmount * now) / sold;
    if (sold > MAX_EVALUATED_UNITS) throw new OfferReturnInvariantError(`line ${line.lineRef} has more units than one evaluation expands`);
    for (let i = 0n; i < sold - before - now; i++) kept.push({ price, order, productId: line.productId });
  });
  const dHeld = held - clawbacksBefore;
  const discReturned = discNow < dHeld ? discNow : dHeld;
  const dRemaining = totalDiscountOf(kept, offer);
  const lost = dHeld - dRemaining;
  const refund = gross - (discReturned > lost ? discReturned : lost);
  const clawback = lost - discReturned > 0n ? lost - discReturned : 0n;
  return {
    dHeld,
    discReturned,
    dRemaining,
    netReturned: net,
    grossReturned: gross,
    refund,
    clawback: refund < 0n ? null : clawback,
    giveBack: discNow - discReturned,
  };
}
