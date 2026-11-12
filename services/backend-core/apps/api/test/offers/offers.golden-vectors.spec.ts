/**
 * RT-1335 (RT-286 slice S2, seeding S5) — the Offer Engine golden vectors
 * (`packages/contracts/fixtures/offers/golden-vectors.json`).
 *
 * Pure: no app, no HTTP, and no import from `src/`. A small reference
 * evaluator written here from spec 048 §6 and §9 recomputes every vector in
 * exact integer minor units and must agree with the file, so the file is
 * internally consistent and matches the spec's worked examples (§6.1 E1–E8,
 * the §9 return table, and multi-return sequences where earlier returns and
 * their clawbacks change what a later return refunds). The Backend-Core (RT-1337) and POS evaluators consume
 * the same file; they are not tested here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Offer = { buyQuantity: number; getQuantity: number; percentOff: string; maxApplicationsPerSale: number | null };
type CartLine = {
  lineRef: string;
  productId: string;
  unitPrice: string;
  quantity: string;
  eligible: boolean;
  manualDiscount?: { kind: string; value: string; amount: string };
};
type OutLine = { lineRef: string; productId: string; quantity: string; unitPrice: string; lineAmount: string; promotionDiscount: string | null };
type Evaluation = {
  applications: number;
  rewards: Array<{ lineRef: string; unitPrice: string; discountAmount: string }>;
  totalDiscount: string;
  total: string;
  lines: OutLine[];
};
type EvaluateVector = { id: string; description: string; offer: Offer; currencyCode: string; minorUnit: number; cart: CartLine[]; expected: Evaluation };
type SaleLine = { saleLineRef: string; productId: string; unitPrice: string; quantity: string; lineAmount: string; promotion: { discountAmount: string } | null };
type Returned = Array<{ saleLineRef: string; quantity: string }>;
type StepExpected = {
  dHeld: string;
  discReturned: string;
  dRemaining: string;
  netReturned: string;
  grossReturned: string;
  refund: string;
  clawback: string | null;
  /** A discount an earlier return clawed back, given back now (OD-11 Hybrid). */
  giveBack: string;
  outcome: "accepted" | "promotion_clawback_exceeds_refund" | "promotion_return_requires_clawback";
  /** The per-line split the posting feed carries; checked by `offer-evaluator.golden.spec.ts`. */
  feedLines?: Array<{ saleLineRef: string; promotionClawbackAmount?: string; promotionGiveBackAmount?: string }>;
};
type Sale = { id: string; description: string; fromVector: string; offer: Offer; currencyCode: string; minorUnit: number; saleLines: SaleLine[] };
type ReturnVector = Sale & { returned: Returned; expected: StepExpected & { dOrig: string } };
type ReturnSequence = Sale & { steps: Array<{ returned: Returned; expected: StepExpected }> };
type GoldenVectors = {
  version: number;
  source: string;
  notes: string[];
  evaluate: EvaluateVector[];
  returns: ReturnVector[];
  returnSequences: ReturnSequence[];
};

const FILE = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "fixtures", "offers", "golden-vectors.json");
const vectors = JSON.parse(readFileSync(FILE, "utf8")) as GoldenVectors;

const QUANTITY_SCALE = 6;

/** An exact-decimal string as an integer count of 10^-scale units; throws when it has more digits than `scale`. */
function scaled(value: string, scale: number): bigint {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (!match) throw new Error(`not a decimal: ${value}`);
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (fraction.length > scale) throw new Error(`${value} has more than ${scale} fractional digits`);
  const units = BigInt(match[2]! + fraction.padEnd(scale, "0"));
  return match[1] === "-" ? -units : units;
}

/** Minor units as the string the vectors use: exactly `minorUnit` fractional digits. */
function format(minor: bigint, minorUnit: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(minorUnit + 1, "0");
  const text = minorUnit === 0 ? digits : `${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}`;
  return negative ? `-${text}` : text;
}

/** Half up once at the minor unit (OD-28-3): P% of a non-negative unit price. */
function percentOf(priceMinor: bigint, percent: string): bigint {
  return (priceMinor * BigInt(percent) + 50n) / 100n;
}

/** The whole number of units in a quantity, or null when it is not whole (F-9). */
function wholeUnits(quantity: string): bigint | null {
  const q = scaled(quantity, QUANTITY_SCALE);
  const one = 10n ** BigInt(QUANTITY_SCALE);
  return q % one === 0n ? q / one : null;
}

type Unit = { price: bigint; order: number; productId: string };

/** Spec 048 §6 steps 2–4: order the units and pick the rewards (OD-2). */
function rewardsOf(units: Unit[], offer: Offer): { applications: number; rewards: Unit[] } {
  const ordered = [...units].sort(
    (a, b) => (a.price === b.price ? 0 : a.price > b.price ? -1 : 1) || a.order - b.order || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
  );
  let applications = Math.floor(ordered.length / (offer.buyQuantity + offer.getQuantity));
  if (offer.maxApplicationsPerSale !== null) applications = Math.min(applications, offer.maxApplicationsPerSale);
  const rewardCount = applications * offer.getQuantity;
  return { applications, rewards: rewardCount === 0 ? [] : ordered.slice(ordered.length - rewardCount) };
}

/** Spec 048 §6, the reference evaluation of one cart. */
function evaluate(vector: EvaluateVector): Evaluation {
  const { offer, cart, minorUnit } = vector;
  const units: Unit[] = cart.flatMap((line, order) => {
    const whole = wholeUnits(line.quantity);
    if (!line.eligible || line.manualDiscount || whole === null) return [];
    return Array.from({ length: Number(whole) }, () => ({ price: scaled(line.unitPrice, minorUnit), order, productId: line.productId }));
  });
  const { applications, rewards } = rewardsOf(units, offer);
  const participating = new Set(units.map((u) => u.order));
  const perLine = new Map<number, bigint[]>();
  for (const r of rewards) perLine.set(r.order, [...(perLine.get(r.order) ?? []), percentOf(r.price, offer.percentOff)]);

  const lines: OutLine[] = cart.flatMap((line, order): OutLine[] => {
    const price = scaled(line.unitPrice, minorUnit);
    const base = { lineRef: line.lineRef, productId: line.productId, unitPrice: line.unitPrice };
    if (applications === 0 || !participating.has(order)) {
      const gross = (price * scaled(line.quantity, QUANTITY_SCALE)) / 10n ** BigInt(QUANTITY_SCALE);
      const manual = line.manualDiscount ? scaled(line.manualDiscount.amount, minorUnit) : 0n;
      return [{ ...base, quantity: line.quantity, lineAmount: format(gross - manual, minorUnit), promotionDiscount: null }];
    }
    const discounts = perLine.get(order) ?? [];
    const rest = wholeUnits(line.quantity)! - BigInt(discounts.length);
    return [
      ...(rest > 0n ? [{ ...base, quantity: rest.toString(), lineAmount: format(price * rest, minorUnit), promotionDiscount: format(0n, minorUnit) }] : []),
      ...discounts.map((d) => ({ ...base, quantity: "1", lineAmount: format(price - d, minorUnit), promotionDiscount: format(d, minorUnit) })),
    ];
  });
  const totalDiscount = rewards.reduce((sum, r) => sum + percentOf(r.price, offer.percentOff), 0n);
  return {
    applications,
    rewards: rewards.map((r) => ({
      lineRef: cart[r.order]!.lineRef,
      unitPrice: cart[r.order]!.unitPrice,
      discountAmount: format(percentOf(r.price, offer.percentOff), minorUnit),
    })),
    totalDiscount: format(totalDiscount, minorUnit),
    total: format(lines.reduce((sum, l) => sum + scaled(l.lineAmount, minorUnit), 0n), minorUnit),
    lines,
  };
}

/** What earlier returns of the sale left behind: units returned per sale line, and clawbacks recorded. */
type ReturnHistory = { returnedUnits: Map<string, bigint>; clawbacks: bigint };

/**
 * Spec 048 §9 (multi-return form), for the one offer O of the sale: one
 * return after `history`, with the frozen version and prices. Updates
 * `history` as if the return were recorded (a refused return is not).
 */
function settleReturn(sale: Sale, returned: Returned, history: ReturnHistory): StepExpected {
  const { offer, saleLines, minorUnit } = sale;
  const now = new Map(returned.map((r) => [r.saleLineRef, wholeUnits(r.quantity)!]));
  let held = 0n;
  let discNow = 0n;
  let net = 0n;
  let gross = 0n;
  const kept: Unit[] = [];
  saleLines.forEach((l, order) => {
    if (l.promotion === null) return;
    const sold = wholeUnits(l.quantity)!;
    const discount = scaled(l.promotion.discountAmount, minorUnit);
    expect(discount % sold).toBe(0n);
    const unitDiscount = discount / sold;
    const before = history.returnedUnits.get(l.saleLineRef) ?? 0n;
    const q = now.get(l.saleLineRef) ?? 0n;
    held += unitDiscount * (sold - before);
    discNow += unitDiscount * q;
    gross += scaled(l.unitPrice, minorUnit) * q;
    const lineAmount = scaled(l.lineAmount, minorUnit);
    expect((lineAmount * q) % sold).toBe(0n);
    net += (lineAmount * q) / sold;
    for (let i = 0n; i < sold - before - q; i++) kept.push({ price: scaled(l.unitPrice, minorUnit), order, productId: l.productId });
  });
  // D_held: the discount still held on the units not returned before, less the clawbacks already recorded.
  held -= history.clawbacks;
  const discReturned = discNow < held ? discNow : held;
  const dRemaining = rewardsOf(kept, offer).rewards.reduce((sum, r) => sum + percentOf(r.price, offer.percentOff), 0n);
  const lost = held - dRemaining;
  const refund = gross - (discReturned > lost ? discReturned : lost);
  const clawback = lost - discReturned > 0n ? lost - discReturned : 0n;
  // What an earlier clawback took from the units returned now is given back (OD-11 Hybrid).
  const giveBack = discNow - discReturned;
  const outcome =
    refund < 0n
      ? "promotion_clawback_exceeds_refund"
      : clawback > 0n || giveBack > 0n
        ? "promotion_return_requires_clawback"
        : "accepted";
  if (refund >= 0n) {
    for (const [ref, q] of now) history.returnedUnits.set(ref, (history.returnedUnits.get(ref) ?? 0n) + q);
    history.clawbacks += clawback;
  }
  return {
    dHeld: format(held, minorUnit),
    discReturned: format(discReturned, minorUnit),
    dRemaining: format(dRemaining, minorUnit),
    netReturned: format(net, minorUnit),
    grossReturned: format(gross, minorUnit),
    refund: format(refund, minorUnit),
    clawback: refund < 0n ? null : format(clawback, minorUnit),
    giveBack: format(giveBack, minorUnit),
    outcome,
  };
}

const freshHistory = (): ReturnHistory => ({ returnedUnits: new Map(), clawbacks: 0n });

describe("offers golden vectors — file", () => {
  it("is version 1, cites spec 048 and has unique ids", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.source).toContain("spec 048");
    const ids = [...vectors.evaluate, ...vectors.returns].map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("holds the eight worked examples of spec 048 §6.1 with the spec's totals", () => {
    const byId = new Map(vectors.evaluate.map((v) => [v.id, v.expected]));
    const spec: Array<[string, number, string, string]> = [
      ["E1", 1, "80.00", "420.00"],
      ["E2", 2, "40.00", "240.00"],
      ["E3", 1, "16.00", "184.00"],
      ["E4", 1, "60.00", "240.00"],
      ["E5", 1, "16.00", "264.00"],
      ["E6", 1, "13.33", "70.00"],
      ["E7", 0, "0.00", "150.00"],
      ["E8", 1, "24.00", "176.00"],
    ];
    for (const [id, k, discount, total] of spec) {
      const e = byId.get(id);
      expect([id, e?.applications, e?.totalDiscount, e?.total]).toEqual([id, k, discount, total]);
    }
    // OD-2: E2's rewards are the two cheapest units of the basket, 60 and 40.
    expect(byId.get("E2")?.rewards.map((r) => r.unitPrice).sort()).toEqual(["40.00", "60.00"]);
    // OD-4: E4 shows two quantity-1 lines, 150.00 and 90.00.
    expect(byId.get("E4")?.lines.map((l) => [l.quantity, l.lineAmount])).toEqual([["1", "150.00"], ["1", "90.00"]]);
  });

  it("holds the spec 048 §9 return table", () => {
    const byId = new Map(vectors.returns.map((v) => [v.id, v.expected]));
    expect([byId.get("R1")?.dRemaining, byId.get("R1")?.refund]).toEqual(["24.00", "24.00"]);
    expect([byId.get("R2")?.dRemaining, byId.get("R2")?.refund]).toEqual(["16.00", "100.00"]);
    expect([byId.get("R3")?.dRemaining, byId.get("R3")?.refund]).toEqual(["0.00", "220.00"]);
  });

  it("covers the OD-10 refusal and the OD-11 interim refusal", () => {
    const outcomes = vectors.returns.map((v) => v.expected.outcome);
    expect(outcomes).toContain("promotion_clawback_exceeds_refund");
    expect(outcomes).toContain("promotion_return_requires_clawback");
    expect(outcomes).toContain("accepted");
  });
});

describe("offers golden vectors — evaluation (spec 048 §6)", () => {
  it.each(vectors.evaluate.map((v) => [v.id, v] as const))("%s agrees with the reference evaluator", (_id, vector) => {
    expect(evaluate(vector)).toEqual(vector.expected);
  });

  it.each(vectors.evaluate.map((v) => [v.id, v] as const))("%s is arithmetically consistent", (_id, vector) => {
    const { expected, cart, minorUnit, offer } = vector;
    const m = (s: string): bigint => scaled(s, minorUnit);
    const gross = cart.reduce((sum, l) => sum + (m(l.unitPrice) * scaled(l.quantity, QUANTITY_SCALE)) / 10n ** BigInt(QUANTITY_SCALE), 0n);
    const manual = cart.reduce((sum, l) => sum + (l.manualDiscount ? m(l.manualDiscount.amount) : 0n), 0n);
    // total = Σ gross − Σ manual discount − totalDiscount, and = Σ line nets.
    expect(m(expected.total)).toBe(gross - manual - m(expected.totalDiscount));
    expect(expected.lines.reduce((sum, l) => sum + m(l.lineAmount), 0n)).toBe(m(expected.total));
    // totalDiscount = Σ reward discounts, each half up at the minor unit, k × Y rewards.
    expect(expected.rewards.reduce((sum, r) => sum + m(r.discountAmount), 0n)).toBe(m(expected.totalDiscount));
    for (const r of expected.rewards) expect(m(r.discountAmount)).toBe(percentOf(m(r.unitPrice), offer.percentOff));
    expect(expected.rewards).toHaveLength(expected.applications * offer.getQuantity);
    // OD-4: a line with a promotion discount above 0 has quantity 1; every line keeps the net invariant.
    for (const l of expected.lines) {
      const discount = l.promotionDiscount === null ? 0n : m(l.promotionDiscount);
      if (discount > 0n) expect(l.quantity).toBe("1");
      if (l.promotionDiscount !== null) {
        expect(m(l.lineAmount)).toBe(m(l.unitPrice) * wholeUnits(l.quantity)! - discount);
      }
      expect(m(l.lineAmount) >= 0n).toBe(true);
    }
    // OD-5: a manually discounted line never carries a promotion.
    const manualRefs = new Set(cart.filter((l) => l.manualDiscount).map((l) => l.lineRef));
    expect(expected.lines.filter((l) => manualRefs.has(l.lineRef) && l.promotionDiscount !== null)).toEqual([]);
  });
});

describe("offers golden vectors — returns and clawback (spec 048 §9)", () => {
  const byId = new Map(vectors.evaluate.map((v) => [v.id, v]));

  it.each(vectors.returns.map((v) => [v.id, v] as const))("%s agrees with the reference refund", (_id, vector) => {
    const { dOrig, feedLines: _feedLines, ...expected } = vector.expected;
    expect(settleReturn(vector, vector.returned, freshHistory())).toEqual(expected);
    // On a first return D_held is D_orig, and the refund is the single-return form of §9:
    // min(net returned, gross returned − (D_orig − D_remaining)).
    expect(expected.dHeld).toBe(dOrig);
    const m = (x: string): bigint => scaled(x, vector.minorUnit);
    const byGross = m(expected.grossReturned) - (m(dOrig) - m(expected.dRemaining));
    expect(m(expected.refund)).toBe(m(expected.netReturned) < byGross ? m(expected.netReturned) : byGross);
  });

  it.each(vectors.returns.map((v) => [v.id, v] as const))("%s is the sale of its source vector", (_id, vector) => {
    const source = byId.get(vector.fromVector)!;
    expect(vector.offer).toEqual(source.offer);
    expect(vector.minorUnit).toBe(source.minorUnit);
    expect(
      vector.saleLines.map((l) => [l.productId, l.quantity, l.unitPrice, l.lineAmount, l.promotion?.discountAmount ?? null]),
    ).toEqual(source.expected.lines.map((l) => [l.productId, l.quantity, l.unitPrice, l.lineAmount, l.promotionDiscount]));
    // D_orig is the sale's total offer discount.
    expect(vector.expected.dOrig).toBe(source.expected.totalDiscount);
  });

  it.each(vectors.returns.map((v) => [v.id, v] as const))("%s never refunds more than the net nor creates a discount", (_id, vector) => {
    const m = (s: string): bigint => scaled(s, vector.minorUnit);
    const e = vector.expected;
    expect(m(e.refund) <= m(e.netReturned)).toBe(true);
    expect(m(e.refund) <= m(e.grossReturned) - (m(e.dOrig) - m(e.dRemaining))).toBe(true);
    // Hybrid: the refund is the net, plus a give-back of an earlier clawback, less this return's clawback.
    if (e.clawback !== null) expect(m(e.netReturned) + m(e.giveBack) - m(e.clawback)).toBe(m(e.refund));
  });
});

describe("offers golden vectors — return sequences (spec 048 §9, multi-return form)", () => {
  const byId = new Map(vectors.evaluate.map((v) => [v.id, v]));

  it("holds the three reviewed sequences", () => {
    const refunds = new Map(vectors.returnSequences.map((s) => [s.id, s.steps.map((st) => st.expected.refund)]));
    expect(refunds.get("S1-y-greater-than-x")).toEqual(["0.00", "50.00"]);
    expect(refunds.get("S2-three-returns")).toEqual(["24.00", "36.00", "100.00"]);
    expect(refunds.get("S3-clawback-then-reward")).toEqual(["220.00", "200.00"]);
    // Hybrid (owner decision 2026-11-12): the second refund is the line's net 120.00 plus a give-back of 80.00.
    const s3 = vectors.returnSequences.find((s) => s.id === "S3-clawback-then-reward")!;
    expect([s3.steps[1]!.expected.netReturned, s3.steps[1]!.expected.giveBack]).toEqual(["120.00", "80.00"]);
  });

  it.each(vectors.returnSequences.map((v) => [v.id, v] as const))("%s agrees with the reference refund, step by step", (_id, sequence) => {
    const history = freshHistory();
    for (const [index, step] of sequence.steps.entries()) {
      // A step the runtime still refuses (a clawback or a give-back, until the Connector posts them) counts as recorded.
      const { feedLines: _feedLines, ...expected } = step.expected;
      expect([index, settleReturn(sequence, step.returned, history)]).toEqual([index, expected]);
    }
  });

  it.each(vectors.returnSequences.map((v) => [v.id, v] as const))("%s never refunds more than was paid, and all of it once every unit is back", (_id, sequence) => {
    const source = byId.get(sequence.fromVector)!;
    const m = (x: string): bigint => scaled(x, sequence.minorUnit);
    expect(sequence.saleLines.map((l) => l.lineAmount)).toEqual(source.expected.lines.map((l) => l.lineAmount));
    const refunded = sequence.steps.reduce((sum, st) => sum + m(st.expected.refund), 0n);
    const returnedAll = sequence.steps.flatMap((st) => st.returned.map((r) => r.saleLineRef));
    const everything = sequence.saleLines.every((l) => returnedAll.includes(l.saleLineRef));
    expect(refunded <= m(source.expected.total)).toBe(true);
    if (everything) expect(refunded).toBe(m(source.expected.total));
    for (const st of sequence.steps) expect(m(st.expected.refund) >= 0n).toBe(true);
  });
});
