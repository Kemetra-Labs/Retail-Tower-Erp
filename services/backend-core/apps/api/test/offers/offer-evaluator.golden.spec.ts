/**
 * RT-1337 (RT-286 S4) — the REAL evaluator (`src/offers/evaluator`) against
 * every golden vector of `packages/contracts/fixtures/offers/golden-vectors.json`
 * (E1–E8, X1–X9, R1–R9, S1–S3). The sibling `offers.golden-vectors.spec.ts`
 * proves the file against a test-local reference; this one proves the code the
 * runtime ships.
 *
 * `outcome` in the file keeps the RT-1335 wording: `promotion_return_requires_clawback`
 * marks a return whose clawback is above 0. Since OD-11 = A (RT-1340) the
 * runtime ACCEPTS such a return and records the clawback; the vector's numbers
 * (refund, clawback) are what must hold.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { formatMinor, scaled, wholeUnits } from "../../src/offers/evaluator/offer-decimal";
import { evaluateOffer, type CartLine, type Evaluation, type EvaluatorOffer } from "../../src/offers/evaluator/offer-evaluator";
import { settleOfferReturn, type SaleOfferLine } from "../../src/offers/evaluator/offer-return-settlement";

interface VectorOffer { buyQuantity: number; getQuantity: number; percentOff: string; maxApplicationsPerSale: number | null }
interface EvaluateVector {
  id: string;
  offer: VectorOffer;
  minorUnit: number;
  cart: Array<CartLine & { manualDiscount?: { kind: string; value: string; amount: string } }>;
  expected: Evaluation;
}
interface VectorSaleLine { saleLineRef: string; productId: string; unitPrice: string; quantity: string; lineAmount: string; promotion: { discountAmount: string } | null }
type Returned = Array<{ saleLineRef: string; quantity: string }>;
interface StepExpected {
  dHeld: string; discReturned: string; dRemaining: string; netReturned: string; grossReturned: string;
  refund: string; clawback: string | null;
  outcome: "accepted" | "promotion_clawback_exceeds_refund" | "promotion_return_requires_clawback";
}
interface Sale { id: string; offer: VectorOffer; minorUnit: number; saleLines: VectorSaleLine[] }
interface ReturnVector extends Sale { returned: Returned; expected: StepExpected & { dOrig: string } }
interface SequenceVector extends Sale { steps: Array<{ returned: Returned; expected: StepExpected }> }
interface Vectors { evaluate: EvaluateVector[]; returns: ReturnVector[]; returnSequences: SequenceVector[] }

const FILE = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "fixtures", "offers", "golden-vectors.json");
const vectors = JSON.parse(readFileSync(FILE, "utf8")) as Vectors;

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
      : [{ lineRef: l.saleLineRef, productId: l.productId, unitPrice: l.unitPrice, quantity: l.quantity, lineAmount: l.lineAmount, discountAmount: l.promotion.discountAmount }],
  );

const unitsOf = (returned: Returned): Map<string, bigint> => new Map(returned.map((r) => [r.saleLineRef, wholeUnits(r.quantity)!]));

/** Applies the evaluator's settlement to the vector's expectations. */
function settle(sale: Sale, returned: Returned, history: { units: Map<string, bigint>; clawbacks: bigint }) {
  const s = settleOfferReturn({
    offer: offerOf(sale.offer),
    minorUnit: sale.minorUnit,
    saleLines: offerLines(sale),
    returnedBefore: history.units,
    clawbacksBefore: history.clawbacks,
    returnedNow: unitsOf(returned),
  });
  if (s.refund >= 0n) {
    for (const [ref, q] of unitsOf(returned)) history.units.set(ref, (history.units.get(ref) ?? 0n) + q);
    history.clawbacks += s.clawback ?? 0n;
  }
  return s;
}

function expectStep(sale: Sale, s: ReturnType<typeof settle>, e: StepExpected): void {
  const f = (v: bigint | null): string | null => (v === null ? null : formatMinor(v, sale.minorUnit));
  expect({
    dHeld: f(s.dHeld),
    discReturned: f(s.discReturned),
    dRemaining: f(s.dRemaining),
    netReturned: f(s.netReturned),
    grossReturned: f(s.grossReturned),
    refund: f(s.refund),
    clawback: f(s.clawback),
  }).toEqual({
    dHeld: e.dHeld, discReturned: e.discReturned, dRemaining: e.dRemaining, netReturned: e.netReturned,
    grossReturned: e.grossReturned, refund: e.refund, clawback: e.clawback,
  });
  const outcome = s.refund < 0n ? "promotion_clawback_exceeds_refund" : (s.clawback ?? 0n) > 0n ? "promotion_return_requires_clawback" : "accepted";
  expect(outcome).toBe(e.outcome);
}

describe("offer evaluator — golden vectors (spec 048 §6)", () => {
  it("covers every vector of the file", () => {
    expect(vectors.evaluate.map((v) => v.id)).toHaveLength(17);
    expect(vectors.returns).toHaveLength(9);
    expect(vectors.returnSequences).toHaveLength(3);
  });

  it.each(vectors.evaluate.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const cart: CartLine[] = v.cart.map((l) => ({
      lineRef: l.lineRef,
      productId: l.productId,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      eligible: l.eligible,
      ...(l.manualDiscount ? { manualDiscount: { amount: l.manualDiscount.amount } } : {}),
    }));
    expect(evaluateOffer({ offer: offerOf(v.offer), minorUnit: v.minorUnit, cart })).toEqual(v.expected);
  });

  it("is deterministic and never mutates its input", () => {
    const v = vectors.evaluate.find((x) => x.id === "E2")!;
    const cart = v.cart.map((l) => ({ lineRef: l.lineRef, productId: l.productId, unitPrice: l.unitPrice, quantity: l.quantity, eligible: l.eligible }));
    const frozen = JSON.stringify(cart);
    const a = evaluateOffer({ offer: offerOf(v.offer), minorUnit: v.minorUnit, cart });
    const b = evaluateOffer({ offer: offerOf(v.offer), minorUnit: v.minorUnit, cart: [...cart].reverse().reverse() });
    expect(a).toEqual(b);
    expect(JSON.stringify(cart)).toBe(frozen);
  });
});

describe("offer return settlement — golden vectors (spec 048 §9)", () => {
  it.each(vectors.returns.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const s = settle(v, v.returned, { units: new Map(), clawbacks: 0n });
    expectStep(v, s, v.expected);
    expect(formatMinor(s.dHeld, v.minorUnit)).toBe(v.expected.dOrig);
    expect(s.giveBack).toBe(0n);
  });

  it.each(vectors.returnSequences.map((v) => [v.id, v] as const))("%s, step by step", (_id, seq) => {
    const history = { units: new Map<string, bigint>(), clawbacks: 0n };
    const giveBacks: bigint[] = [];
    for (const step of seq.steps) {
      const s = settle(seq, step.returned, history);
      expectStep(seq, s, step.expected);
      giveBacks.push(s.giveBack);
    }
    // Only S3's second step gives an earlier clawback back (the case the service refuses, fail closed).
    expect(giveBacks.map((g) => g > 0n)).toEqual(seq.steps.map((_, i) => seq.id === "S3-clawback-then-reward" && i === 1));
  });

  it("refunds, over a sequence that returns every unit, exactly what was paid", () => {
    for (const seq of vectors.returnSequences.filter((q) => q.id !== "S2-three-returns")) {
      const paid = seq.saleLines.reduce((sum, l) => sum + scaled(l.lineAmount, seq.minorUnit), 0n);
      const refunded = seq.steps.reduce((sum, st) => sum + scaled(st.expected.refund, seq.minorUnit), 0n);
      expect(refunded).toBe(paid);
    }
  });
});
