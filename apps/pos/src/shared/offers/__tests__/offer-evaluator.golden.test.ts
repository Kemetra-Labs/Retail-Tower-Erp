/**
 * RT-1339 (RT-286 S7) — the POS evaluator against EVERY golden vector of the
 * shared file (E1–E8, X1–X9, R1–R9, S1–S3). The file is a byte-identical copy of
 * `services/backend-core/packages/contracts/fixtures/offers/golden-vectors.json`
 * (`contracts/check` `identical:`), so POS and Backend-Core pass the same cases.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMinor, scaled, wholeUnits } from '../offer-decimal.js';
import {
  evaluateOffer,
  type CartLine,
  type Evaluation,
  type EvaluatorOffer,
} from '../offer-evaluator.js';
import { settleOfferReturn, type SaleOfferLine } from '../offer-return-settlement.js';

interface VectorOffer {
  buyQuantity: number;
  getQuantity: number;
  percentOff: string;
  maxApplicationsPerSale: number | null;
}
interface EvaluateVector {
  id: string;
  offer: VectorOffer;
  minorUnit: number;
  cart: Array<CartLine & { manualDiscount?: { kind: string; value: string; amount: string } }>;
  expected: Evaluation;
}
interface VectorSaleLine {
  saleLineRef: string;
  productId: string;
  unitPrice: string;
  quantity: string;
  lineAmount: string;
  promotion: { discountAmount: string } | null;
}
type Returned = Array<{ saleLineRef: string; quantity: string }>;
interface StepExpected {
  dHeld: string;
  discReturned: string;
  dRemaining: string;
  netReturned: string;
  grossReturned: string;
  refund: string;
  clawback: string | null;
  giveBack: string;
  outcome: 'accepted' | 'promotion_clawback_exceeds_refund' | 'promotion_return_requires_clawback';
}
interface Sale {
  id: string;
  offer: VectorOffer;
  minorUnit: number;
  saleLines: VectorSaleLine[];
}
interface ReturnVector extends Sale {
  returned: Returned;
  expected: StepExpected & { dOrig: string };
}
interface SequenceVector extends Sale {
  steps: Array<{ returned: Returned; expected: StepExpected }>;
}
interface Vectors {
  evaluate: EvaluateVector[];
  returns: ReturnVector[];
  returnSequences: SequenceVector[];
}

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, 'offers-golden-vectors.json'), 'utf8'),
) as Vectors;

const offerOf = (o: VectorOffer): EvaluatorOffer => ({
  buyQuantity: o.buyQuantity,
  getQuantity: o.getQuantity,
  percentOff: o.percentOff,
  maxApplicationsPerSale: o.maxApplicationsPerSale,
});

const offerLines = (sale: Sale): SaleOfferLine[] =>
  sale.saleLines.flatMap((l) =>
    l.promotion === null
      ? []
      : [
          {
            lineRef: l.saleLineRef,
            productId: l.productId,
            unitPrice: l.unitPrice,
            quantity: l.quantity,
            lineAmount: l.lineAmount,
            discountAmount: l.promotion.discountAmount,
          },
        ],
  );

const unitsOf = (returned: Returned): Map<string, bigint> =>
  new Map(returned.map((r) => [r.saleLineRef, wholeUnits(r.quantity) ?? 0n]));

function settle(
  sale: Sale,
  returned: Returned,
  history: { units: Map<string, bigint>; clawbacks: bigint },
) {
  const s = settleOfferReturn({
    offer: offerOf(sale.offer),
    minorUnit: sale.minorUnit,
    saleLines: offerLines(sale),
    returnedBefore: history.units,
    clawbacksBefore: history.clawbacks,
    returnedNow: unitsOf(returned),
  });
  if (s.refund >= 0n) {
    for (const [ref, q] of unitsOf(returned)) {
      history.units.set(ref, (history.units.get(ref) ?? 0n) + q);
    }
    // The OUTSTANDING clawback: recorded clawbacks net of the give-backs of earlier returns (RT-1367).
    history.clawbacks += (s.clawback ?? 0n) - s.giveBack;
  }
  return s;
}

function expectStep(sale: Sale, s: ReturnType<typeof settle>, e: StepExpected): void {
  const f = (v: bigint | null): string | null =>
    v === null ? null : formatMinor(v, sale.minorUnit);
  expect({
    dHeld: f(s.dHeld),
    discReturned: f(s.discReturned),
    dRemaining: f(s.dRemaining),
    netReturned: f(s.netReturned),
    grossReturned: f(s.grossReturned),
    refund: f(s.refund),
    clawback: f(s.clawback),
    giveBack: f(s.giveBack),
  }).toEqual({
    dHeld: e.dHeld,
    discReturned: e.discReturned,
    dRemaining: e.dRemaining,
    netReturned: e.netReturned,
    grossReturned: e.grossReturned,
    refund: e.refund,
    clawback: e.clawback,
    giveBack: e.giveBack,
  });
  const outcome =
    s.refund < 0n
      ? 'promotion_clawback_exceeds_refund'
      : (s.clawback ?? 0n) > 0n || s.giveBack > 0n
        ? 'promotion_return_requires_clawback'
        : 'accepted';
  expect(outcome).toBe(e.outcome);
}

describe('POS offer evaluator — golden vectors (spec 048 §6)', () => {
  it('covers every vector of the file', () => {
    expect(vectors.evaluate).toHaveLength(17);
    expect(vectors.returns).toHaveLength(9);
    expect(vectors.returnSequences).toHaveLength(3);
  });

  it.each(vectors.evaluate.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const cart: CartLine[] = v.cart.map((l) => ({
      lineRef: l.lineRef,
      productId: l.productId,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      eligible: l.eligible,
      ...(l.manualDiscount ? { manualDiscount: { amount: l.manualDiscount.amount } } : {}),
    }));
    expect(evaluateOffer({ offer: offerOf(v.offer), minorUnit: v.minorUnit, cart })).toEqual(
      v.expected,
    );
  });
});

describe('POS return settlement — golden vectors (spec 048 §9)', () => {
  it.each(vectors.returns.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const s = settle(v, v.returned, { units: new Map(), clawbacks: 0n });
    expectStep(v, s, v.expected);
    expect(formatMinor(s.dHeld, v.minorUnit)).toBe(v.expected.dOrig);
    expect(s.giveBack).toBe(0n);
  });

  it.each(vectors.returnSequences.map((v) => [v.id, v] as const))(
    '%s, step by step',
    (_id, seq) => {
      const history = { units: new Map<string, bigint>(), clawbacks: 0n };
      for (const step of seq.steps)
        expectStep(seq, settle(seq, step.returned, history), step.expected);
    },
  );

  it('refunds, over a sequence that returns every unit, exactly what was paid', () => {
    for (const seq of vectors.returnSequences.filter((q) => q.id !== 'S2-three-returns')) {
      const paid = seq.saleLines.reduce((sum, l) => sum + scaled(l.lineAmount, seq.minorUnit), 0n);
      const refunded = seq.steps.reduce(
        (sum, st) => sum + scaled(st.expected.refund, seq.minorUnit),
        0n,
      );
      expect(refunded).toBe(paid);
    }
  });
});
