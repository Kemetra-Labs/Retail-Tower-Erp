/**
 * Spec 048 §9, OD-11 option A + Hybrid: the allocation of a return's clawback and give-back to its lines
 * (`offer-return-allocation.ts`). Pure. The golden vectors check the same rule on the reviewed sequences
 * (`offer-evaluator.golden.spec.ts`).
 */
import {
  allocateReturnPromotion,
  ReturnPromotionOverflowError,
  spreadProportionally,
  type AllocationLine,
} from "../../src/offers/evaluator/offer-return-allocation";

const line = (lineRef: string, lineAmount: bigint, discountReturned = 0n, offerKey = "O:1"): AllocationLine => ({
  lineRef,
  offerKey,
  lineAmount,
  discountReturned,
});
const sum = (m: ReadonlyMap<string, bigint>): bigint => [...m.values()].reduce((a, v) => a + v, 0n);

describe("spreadProportionally", () => {
  it("adds up exactly, largest remainder first, ties by index", () => {
    expect(spreadProportionally(1001n, [10000n])).toEqual([1001n]);
    // 10.01 over three equal lines: 3.34 + 3.34 + 3.33? floor 333 each, 2 left, remainders tie, so the first two get it.
    expect(spreadProportionally(1001n, [10000n, 10000n, 10000n])).toEqual([334n, 334n, 333n]);
  });

  it("never gives a line more than its weight when the total fits", () => {
    for (const total of [0n, 1n, 7n, 99n, 100n, 250n]) {
      const weights = [100n, 99n, 51n];
      const shares = spreadProportionally(total, weights);
      expect(shares.reduce((a, s) => a + s, 0n)).toBe(total);
      shares.forEach((s, i) => expect(s <= weights[i]!).toBe(true));
    }
  });

  it("refuses a total the weights cannot hold", () => {
    expect(() => spreadProportionally(251n, [100n, 99n, 51n])).toThrow(ReturnPromotionOverflowError);
  });
});

describe("allocateReturnPromotion", () => {
  it("E1 return the 300 with a clawback of 80.00: the whole clawback on the one non-reward line", () => {
    const a = allocateReturnPromotion({ lines: [line("a", 30000n)], clawbackByOffer: new Map([["O:1", 8000n]]), giveBackByOffer: new Map() });
    expect([...a.clawback]).toEqual([["a", 8000n]]);
    expect(a.giveBack.size).toBe(0);
  });

  it("S3 step 2 (Hybrid): the reward unit returns at its net 120.00 and takes a give-back of 80.00", () => {
    const a = allocateReturnPromotion({ lines: [line("r", 12000n, 8000n)], clawbackByOffer: new Map(), giveBackByOffer: new Map([["O:1", 8000n]]) });
    expect(a.clawback.size).toBe(0);
    expect([...a.giveBack]).toEqual([["r", 8000n]]);
  });

  it("splits a clawback over non-reward lines in proportion to their amounts, exactly", () => {
    const a = allocateReturnPromotion({
      lines: [line("a", 30000n), line("b", 10000n), line("c", 5000n, 2000n)],
      clawbackByOffer: new Map([["O:1", 1001n]]),
      giveBackByOffer: new Map(),
    });
    expect(sum(a.clawback)).toBe(1001n);
    expect(a.clawback.has("c")).toBe(false); // the reward line takes none while tier 1 can hold it
    expect(a.clawback.get("a")).toBe(751n); // 1001 x 3/4 = 750.75, rounded up by largest remainder
    expect(a.clawback.get("b")).toBe(250n);
  });

  it("spills onto returned reward lines only when the non-reward lines cannot hold the clawback", () => {
    const a = allocateReturnPromotion({
      lines: [line("a", 1000n), line("r", 5000n, 3000n)],
      clawbackByOffer: new Map([["O:1", 2500n]]),
      giveBackByOffer: new Map(),
    });
    expect(a.clawback.get("a")).toBe(1000n);
    expect(a.clawback.get("r")).toBe(1500n);
  });

  it("never takes more than a line's amount, whatever the split", () => {
    const lines = [line("a", 333n), line("b", 333n), line("c", 334n)];
    for (let total = 0n; total <= 1000n; total += 37n) {
      const a = allocateReturnPromotion({ lines, clawbackByOffer: new Map([["O:1", total]]), giveBackByOffer: new Map() });
      expect(sum(a.clawback)).toBe(total);
      lines.forEach((l) => expect((a.clawback.get(l.lineRef) ?? 0n) <= l.lineAmount).toBe(true));
    }
  });

  it("keeps the clawbacks of two offers on the lines of their own offer", () => {
    const a = allocateReturnPromotion({
      lines: [line("a", 1000n, 0n, "O:1"), line("b", 1000n, 0n, "P:2")],
      clawbackByOffer: new Map([["O:1", 100n], ["P:2", 300n]]),
      giveBackByOffer: new Map(),
    });
    expect(a.clawback.get("a")).toBe(100n);
    expect(a.clawback.get("b")).toBe(300n);
  });

  it("splits a give-back over the returned reward lines in proportion to the discount returned now", () => {
    const a = allocateReturnPromotion({
      lines: [line("p", 9000n), line("r1", 2400n, 1600n), line("r2", 1200n, 800n)],
      clawbackByOffer: new Map(),
      giveBackByOffer: new Map([["O:1", 1201n]]),
    });
    expect(sum(a.giveBack)).toBe(1201n);
    expect(a.giveBack.has("p")).toBe(false);
    expect((a.giveBack.get("r1") ?? 0n) <= 1600n && (a.giveBack.get("r2") ?? 0n) <= 800n).toBe(true);
  });

  it("keeps the give-back of one offer on that offer's own reward lines", () => {
    const a = allocateReturnPromotion({
      lines: [line("ra", 4000n, 8000n, "A:1"), line("rb", 5000n, 5000n, "B:1")],
      clawbackByOffer: new Map(),
      giveBackByOffer: new Map([["A:1", 8000n]]),
    });
    expect([...a.giveBack]).toEqual([["ra", 8000n]]);
  });

  it("refuses a clawback that the returned lines of the offer cannot hold (the customer would pay back)", () => {
    expect(() =>
      allocateReturnPromotion({ lines: [line("a", 1000n)], clawbackByOffer: new Map([["O:1", 1001n]]), giveBackByOffer: new Map() }),
    ).toThrow(ReturnPromotionOverflowError);
  });

  it("is deterministic", () => {
    const input = { lines: [line("a", 7n), line("b", 7n), line("c", 7n)], clawbackByOffer: new Map([["O:1", 10n]]), giveBackByOffer: new Map() };
    expect(allocateReturnPromotion(input)).toEqual(allocateReturnPromotion(input));
  });
});
