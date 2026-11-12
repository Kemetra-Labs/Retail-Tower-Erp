/**
 * RT-1339 (RT-286 S7) — return clawback, spec 048 §9, multi-return form. PURE.
 *
 * The same rule Backend-Core's `recordReturn` applies
 * (`offers/evaluator/offer-return-settlement.ts`), proven against the same golden
 * vectors. Backend-Core is the authority: the till uses this only to PREDICT the
 * clawback or refusal before it asks Backend-Core, and shows Backend-Core's answer
 * when it differs.
 *
 * A return uses the FROZEN offer version and unit prices of the sale. For one
 * offer version O, counting every earlier return of the sale:
 *
 *   D_held      = Σ discountAmount of the O units not returned before
 *                 − Σ clawbacks of O already recorded on earlier returns
 *   disc_ret    = min( Σ discountAmount of the O units returned now, D_held )
 *   D_remaining = evaluate(the O units the customer still keeps, O's frozen
 *                 parameters and prices).totalDiscount
 *   refund_O    = Σ gross of the returned O units − max( disc_ret, D_held − D_remaining )
 *   clawback_O  = max( 0, D_held − D_remaining − disc_ret )
 */
import {
  MAX_EVALUATED_UNITS,
  totalDiscountOf,
  type EvaluatorOffer,
  type OfferUnit,
} from './offer-evaluator.js';
import { scaled, wholeUnits } from './offer-decimal.js';

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
  /** Σ clawbacks of this offer version recorded on earlier returns (minor units). */
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
    this.name = 'OfferReturnInvariantError';
  }
}

interface LineFacts {
  held: bigint;
  discNow: bigint;
  gross: bigint;
  net: bigint;
}

function lineFacts(
  line: SaleOfferLine,
  sold: bigint,
  before: bigint,
  now: bigint,
  minorUnit: number,
): LineFacts {
  const discount = scaled(line.discountAmount, minorUnit);
  if (discount % sold !== 0n) {
    throw new OfferReturnInvariantError('a promoted line discount does not divide by its quantity');
  }
  const unitDiscount = discount / sold;
  const lineAmount = scaled(line.lineAmount, minorUnit);
  if ((lineAmount * now) % sold !== 0n) {
    throw new OfferReturnInvariantError('a promoted line net does not divide by its quantity');
  }
  return {
    held: unitDiscount * (sold - before),
    discNow: unitDiscount * now,
    gross: scaled(line.unitPrice, minorUnit) * now,
    net: (lineAmount * now) / sold,
  };
}

export function settleOfferReturn(input: ReturnSettlementInput): ReturnSettlement {
  const { offer, minorUnit, saleLines, returnedBefore, clawbacksBefore, returnedNow } = input;
  let held = 0n;
  let discNow = 0n;
  let net = 0n;
  let gross = 0n;
  const kept: OfferUnit[] = [];
  saleLines.forEach((line, order) => {
    const sold = wholeUnits(line.quantity);
    if (sold === null || sold === 0n) {
      throw new OfferReturnInvariantError('a promoted line has a non-whole quantity');
    }
    if (sold > MAX_EVALUATED_UNITS) {
      throw new OfferReturnInvariantError('a promoted line has too many units');
    }
    const before = returnedBefore.get(line.lineRef) ?? 0n;
    const now = returnedNow.get(line.lineRef) ?? 0n;
    const facts = lineFacts(line, sold, before, now, minorUnit);
    held += facts.held;
    discNow += facts.discNow;
    gross += facts.gross;
    net += facts.net;
    const price = scaled(line.unitPrice, minorUnit);
    for (let i = 0n; i < sold - before - now; i++) {
      kept.push({ price, order, productId: line.productId });
    }
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
