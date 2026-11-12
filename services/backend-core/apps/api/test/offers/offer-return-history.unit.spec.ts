/**
 * Spec 048 §9, OD-11 Hybrid: the outstanding clawback across the returns of one sale (`offer-return-history.ts`).
 * A buy-1-get-2 offer at 40% on 300 + 2 x 200 (540 paid, 160.00 of discount): returning the trigger claws back 160.00,
 * and each reward then gives back 80.00. Subtracting the recorded clawback alone would read the last return's D_held
 * as 80 - 160 = -80 and give back 160.00 on an 80.00 discount (CodeRabbit on #550).
 */
import { formatMinor } from "../../src/offers/evaluator/offer-decimal";
import { replayReturns, type HistoryLine, type HistoryStep } from "../../src/offers/evaluator/offer-return-history";
import { settleOfferReturn, type SaleOfferLine } from "../../src/offers/evaluator/offer-return-settlement";

const OFFER = { buyQuantity: 1, getQuantity: 2, percentOff: "40", maxApplicationsPerSale: null };
const T = "t";
const R1 = "r1";
const R2 = "r2";
const sale: SaleOfferLine[] = [
  { lineRef: T, productId: "p-t", unitPrice: "300.00", quantity: "1", lineAmount: "300.00", discountAmount: "0.00" },
  { lineRef: R1, productId: "p-r1", unitPrice: "200.00", quantity: "1", lineAmount: "120.00", discountAmount: "80.00" },
  { lineRef: R2, productId: "p-r2", unitPrice: "200.00", quantity: "1", lineAmount: "120.00", discountAmount: "80.00" },
];
const KEY = "O:1";
const historyLines: HistoryLine[] = [
  { lineRef: T, offerKey: KEY, sold: 1n, unitDiscount: 0n },
  { lineRef: R1, offerKey: KEY, sold: 1n, unitDiscount: 8000n },
  { lineRef: R2, offerKey: KEY, sold: 1n, unitDiscount: 8000n },
];
const step = (returned: Array<[string, bigint]>, clawback = 0n): HistoryStep => ({
  returned: new Map(returned),
  clawback: new Map(clawback > 0n ? [[KEY, clawback]] : []),
});

describe("replayReturns", () => {
  it("nets each give-back against the outstanding clawback", () => {
    const r = replayReturns(historyLines, [step([[T, 1n]], 16000n), step([[R1, 1n]]), step([[R2, 1n]])]);
    expect(r.giveBacks.map((g) => g.get(KEY) ?? 0n)).toEqual([0n, 8000n, 8000n]);
    expect(r.outstanding.get(KEY)).toBe(0n);
  });

  it("keeps the outstanding clawback after a partial give-back", () => {
    const r = replayReturns(historyLines, [step([[T, 1n]], 16000n), step([[R1, 1n]])]);
    expect(r.outstanding.get(KEY)).toBe(8000n);
  });

  it("has no give-back and nothing outstanding without a clawback", () => {
    const r = replayReturns(historyLines, [step([[R1, 1n]])]);
    expect(r.giveBacks[0]!.size).toBe(0);
    expect(r.outstanding.get(KEY)).toBe(0n);
  });
});

describe("settleOfferReturn with the outstanding clawback: trigger, then each reward", () => {
  it("refunds 140.00, 200.00 and 200.00 = the 540.00 paid, with give-backs of 0, 80.00 and 80.00", () => {
    const returns: Array<Array<[string, bigint]>> = [[[T, 1n]], [[R1, 1n]], [[R2, 1n]]];
    const before = new Map<string, bigint>();
    let outstanding = 0n;
    const out: Array<{ refund: string; clawback: string; giveBack: string }> = [];
    for (const now of returns) {
      const s = settleOfferReturn({
        offer: OFFER,
        minorUnit: 2,
        saleLines: sale,
        returnedBefore: before,
        clawbacksBefore: outstanding,
        returnedNow: new Map(now),
      });
      out.push({ refund: formatMinor(s.refund, 2), clawback: formatMinor(s.clawback ?? 0n, 2), giveBack: formatMinor(s.giveBack, 2) });
      for (const [ref, q] of now) before.set(ref, (before.get(ref) ?? 0n) + q);
      outstanding += (s.clawback ?? 0n) - s.giveBack;
    }
    expect(out).toEqual([
      { refund: "140.00", clawback: "160.00", giveBack: "0.00" },
      { refund: "200.00", clawback: "0.00", giveBack: "80.00" },
      { refund: "200.00", clawback: "0.00", giveBack: "80.00" },
    ]);
    expect(out.reduce((a, o) => a + Number(o.refund), 0)).toBe(540);
  });

  it("the replay and the settlement give the same give-back at every step", () => {
    const steps = [step([[T, 1n]], 16000n), step([[R1, 1n]]), step([[R2, 1n]])];
    const replay = replayReturns(historyLines, steps);
    const before = new Map<string, bigint>();
    let outstanding = 0n;
    steps.forEach((st, i) => {
      const s = settleOfferReturn({ offer: OFFER, minorUnit: 2, saleLines: sale, returnedBefore: before, clawbacksBefore: outstanding, returnedNow: st.returned as Map<string, bigint> });
      expect(replay.giveBacks[i]!.get(KEY) ?? 0n).toBe(s.giveBack);
      for (const [ref, q] of st.returned) before.set(ref, (before.get(ref) ?? 0n) + q);
      outstanding += (s.clawback ?? 0n) - s.giveBack;
    });
  });
});
