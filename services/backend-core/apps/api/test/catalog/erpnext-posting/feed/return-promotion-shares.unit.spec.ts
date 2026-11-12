/**
 * return-promotion-shares.unit.spec.ts — OD-11 (posting-feed 1.13.0-draft): the per-line clawback and
 * give-back of a stored return, derived from rows that never change (no persisted split). The client is
 * faked by SQL text; the allocation rule itself is covered by `offer-return-allocation.unit.spec.ts` and
 * the golden vectors.
 */
import type { PoolClient } from "pg";

import { loadReturnPromotionShares, ReturnPromotionInvariantError } from "../../../../src/catalog/erpnext-posting/return-promotion-shares";

const RETURN_ID = "00000000-0000-7000-8000-0000000ae7e1";
const OFFER = "0a000000-0000-7000-8000-0000000000f1";
const OFFER_B = "0a000000-0000-7000-8000-0000000000f2";
const PLAIN = "0d000000-0000-7000-8000-000000000001";
const REWARD = "0d000000-0000-7000-8000-000000000002";
const REWARD_B = "0d000000-0000-7000-8000-000000000003";

interface ReturnedLine {
  line_ref: string; line_amount: string; quantity: string; sold: string; discount: string; offer_id?: string;
}
interface Fixture {
  /** Clawbacks recorded on THIS return. */
  readonly clawbacks: ReadonlyArray<{ offer_id: string; offer_version: number; amount: string }>;
  readonly lines: ReadonlyArray<ReturnedLine>;
  /** Σ line_amount over EVERY line of the return (promoted or not). */
  readonly allLinesTotal: string;
  readonly returnTotal: string;
  readonly currency?: string;
  /** The sale's returns up to and including this one, as the replay reads them (`sale-return-history.ts`). */
  readonly history?: {
    readonly seq: number;
    readonly claws: ReadonlyArray<{ return_seq: number; offer_id: string; offer_version: number; amount: string }>;
    readonly promoted: ReadonlyArray<{ line_ref: string; sold: string; discount: string; offer_id: string; offer_version: number }>;
    readonly returned: ReadonlyArray<{ return_seq: number; line_ref: string; quantity: string }>;
  };
}

function fakeClient(f: Fixture): PoolClient {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM sale_returns WHERE id")) {
        return { rows: [{ sale_id: "s", tenant_id: "t", return_seq: f.history?.seq ?? 1 }] };
      }
      if (sql.includes("c JOIN sale_returns r ON r.id = c.return_id")) return { rows: f.history?.claws ?? [] };
      if (sql.includes("FROM sale_line_promotions lp JOIN sale_lines sl ON sl.id = lp.sale_line_id")) return { rows: f.history?.promoted ?? [] };
      if (sql.includes("FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.return_id")) return { rows: f.history?.returned ?? [] };
      if (sql.includes("FROM sale_return_promotion_clawbacks WHERE return_id")) return { rows: f.clawbacks };
      if (sql.includes("SUM(line_amount)")) return { rows: [{ total: f.allLinesTotal }] };
      if (sql.includes("JOIN sale_line_promotions lp ON lp.sale_line_id = sl.id\n      WHERE rl.return_id")) {
        return {
          rows: f.lines.map((l) => ({ offer_id: OFFER, ...l, offer_version: 1, currency_code: f.currency ?? "EGP", return_total: f.returnTotal })),
        };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  } as unknown as PoolClient;
}

const line = (line_ref: string, line_amount: string, discount: string, offer_id = OFFER): ReturnedLine => ({
  line_ref, line_amount, quantity: "1.000000", sold: "1.000000", discount, offer_id,
});

describe("loadReturnPromotionShares", () => {
  it("S3 step 1: return the 300 with a clawback of 80.00 puts the clawback on that line", async () => {
    const shares = await loadReturnPromotionShares(
      fakeClient({
        clawbacks: [{ offer_id: OFFER, offer_version: 1, amount: "80.0000" }],
        lines: [line(PLAIN, "300.0000", "0.0000")],
        allLinesTotal: "300.0000",
        returnTotal: "220.0000",
      }),
      RETURN_ID,
    );
    expect([...shares]).toEqual([[PLAIN, { promotionClawbackAmount: "80.0000" }]]);
  });

  it("S3 step 2 (Hybrid): the reward unit refunded 200.00 against a net of 120.00 carries a give-back of 80.00", async () => {
    const shares = await loadReturnPromotionShares(
      fakeClient({
        clawbacks: [],
        lines: [line(REWARD, "120.0000", "80.0000")],
        allLinesTotal: "120.0000",
        returnTotal: "200.0000",
        // Return 1 gave back the 300 with a clawback of 80.00; return 2 (this one) returns the reward unit.
        history: {
          seq: 2,
          claws: [{ return_seq: 1, offer_id: OFFER, offer_version: 1, amount: "80.0000" }],
          promoted: [
            { line_ref: PLAIN, sold: "1.000000", discount: "0.0000", offer_id: OFFER, offer_version: 1 },
            { line_ref: REWARD, sold: "1.000000", discount: "80.0000", offer_id: OFFER, offer_version: 1 },
          ],
          returned: [
            { return_seq: 1, line_ref: PLAIN, quantity: "1.000000" },
            { return_seq: 2, line_ref: REWARD, quantity: "1.000000" },
          ],
        },
      }),
      RETURN_ID,
    );
    expect([...shares]).toEqual([[REWARD, { promotionGiveBackAmount: "80.0000" }]]);
  });

  it("two offers: only the reward line whose offer was clawed back earlier takes the give-back", async () => {
    const shares = await loadReturnPromotionShares(
      fakeClient({
        clawbacks: [],
        lines: [line(REWARD, "120.0000", "80.0000", OFFER), line(REWARD_B, "30.0000", "20.0000", OFFER_B)],
        allLinesTotal: "150.0000",
        returnTotal: "230.0000",
        history: {
          seq: 2,
          claws: [{ return_seq: 1, offer_id: OFFER, offer_version: 1, amount: "80.0000" }],
          promoted: [
            { line_ref: PLAIN, sold: "1.000000", discount: "0.0000", offer_id: OFFER, offer_version: 1 },
            { line_ref: REWARD, sold: "1.000000", discount: "80.0000", offer_id: OFFER, offer_version: 1 },
            { line_ref: REWARD_B, sold: "1.000000", discount: "20.0000", offer_id: OFFER_B, offer_version: 1 },
          ],
          returned: [
            { return_seq: 1, line_ref: PLAIN, quantity: "1.000000" },
            { return_seq: 2, line_ref: REWARD, quantity: "1.000000" },
            { return_seq: 2, line_ref: REWARD_B, quantity: "1.000000" },
          ],
        },
      }),
      RETURN_ID,
    );
    expect([...shares]).toEqual([[REWARD, { promotionGiveBackAmount: "80.0000" }]]);
  });

  it("third return of a buy-1-get-2 sale: the last reward gives back 80.00, not 160.00 (earlier give-backs net the clawback)", async () => {
    const REWARD_2 = "0d000000-0000-7000-8000-000000000004";
    const shares = await loadReturnPromotionShares(
      fakeClient({
        clawbacks: [],
        lines: [line(REWARD_2, "120.0000", "80.0000")],
        allLinesTotal: "120.0000",
        returnTotal: "200.0000",
        history: {
          seq: 3,
          // Return 1 (the trigger) clawed back 160.00; return 2 returned the first reward and gave back 80.00.
          claws: [{ return_seq: 1, offer_id: OFFER, offer_version: 1, amount: "160.0000" }],
          promoted: [
            { line_ref: PLAIN, sold: "1.000000", discount: "0.0000", offer_id: OFFER, offer_version: 1 },
            { line_ref: REWARD, sold: "1.000000", discount: "80.0000", offer_id: OFFER, offer_version: 1 },
            { line_ref: REWARD_2, sold: "1.000000", discount: "80.0000", offer_id: OFFER, offer_version: 1 },
          ],
          returned: [
            { return_seq: 1, line_ref: PLAIN, quantity: "1.000000" },
            { return_seq: 2, line_ref: REWARD, quantity: "1.000000" },
            { return_seq: 3, line_ref: REWARD_2, quantity: "1.000000" },
          ],
        },
      }),
      RETURN_ID,
    );
    expect([...shares]).toEqual([[REWARD_2, { promotionGiveBackAmount: "80.0000" }]]);
  });

  it("a return with neither a clawback nor a give-back has no shares, so its lines are byte-identical", async () => {
    const shares = await loadReturnPromotionShares(
      fakeClient({ clawbacks: [], lines: [line(PLAIN, "100.0000", "0.0000")], allLinesTotal: "100.0000", returnTotal: "100.0000" }),
      RETURN_ID,
    );
    expect(shares.size).toBe(0);
  });

  it("a return with no promoted line has no shares", async () => {
    const shares = await loadReturnPromotionShares(fakeClient({ clawbacks: [], lines: [], allLinesTotal: "5.0000", returnTotal: "5.0000" }), RETURN_ID);
    expect(shares.size).toBe(0);
  });

  it("splits a clawback of 10.01 over a returned line of 3 units exactly, at the feed scale", async () => {
    const shares = await loadReturnPromotionShares(
      fakeClient({
        clawbacks: [{ offer_id: OFFER, offer_version: 1, amount: "10.0100" }],
        lines: [{ ...line(PLAIN, "300.0000", "0.0000"), quantity: "3.000000", sold: "3.000000" }],
        allLinesTotal: "300.0000",
        returnTotal: "289.9900",
      }),
      RETURN_ID,
    );
    expect(shares.get(PLAIN)).toEqual({ promotionClawbackAmount: "10.0100" });
  });

  it("does not read a sub-minor-unit amount of a non-promoted line at the minor unit (RT-740)", async () => {
    // 3.3333 is a manually discounted partial return in the same return; only the column scale can hold it.
    const shares = await loadReturnPromotionShares(
      fakeClient({
        clawbacks: [{ offer_id: OFFER, offer_version: 1, amount: "80.0000" }],
        lines: [line(PLAIN, "300.0000", "0.0000")],
        allLinesTotal: "303.3333",
        returnTotal: "223.3333",
      }),
      RETURN_ID,
    );
    expect(shares.get(PLAIN)).toEqual({ promotionClawbackAmount: "80.0000" });
  });

  it("writes a zero-decimal currency in whole units at the feed scale", async () => {
    const shares = await loadReturnPromotionShares(
      fakeClient({
        clawbacks: [{ offer_id: OFFER, offer_version: 1, amount: "80.0000" }],
        lines: [line(PLAIN, "300.0000", "0.0000")],
        allLinesTotal: "300.0000",
        returnTotal: "220.0000",
        currency: "JPY",
      }),
      RETURN_ID,
    );
    expect(shares.get(PLAIN)).toEqual({ promotionClawbackAmount: "80.0000" });
  });

  it("a three-decimal currency (OMR) splits a clawback in whole mils", async () => {
    const shares = await loadReturnPromotionShares(
      fakeClient({
        clawbacks: [{ offer_id: OFFER, offer_version: 1, amount: "0.0010" }],
        lines: [{ ...line(PLAIN, "0.3000", "0.0000"), quantity: "3.000000", sold: "3.000000" }],
        allLinesTotal: "0.3000",
        returnTotal: "0.2990",
        currency: "OMR",
      }),
      RETURN_ID,
    );
    expect(shares.get(PLAIN)).toEqual({ promotionClawbackAmount: "0.0010" });
  });

  it("refuses a stored return whose total is not its lines net of the clawback plus the give-back", async () => {
    await expect(
      loadReturnPromotionShares(
        fakeClient({
          clawbacks: [{ offer_id: OFFER, offer_version: 1, amount: "10.0000" }],
          lines: [line(PLAIN, "100.0000", "0.0000")],
          allLinesTotal: "100.0000",
          returnTotal: "80.0000",
        }),
        RETURN_ID,
      ),
    ).rejects.toBeInstanceOf(ReturnPromotionInvariantError);
  });

  it("is deterministic across re-pulls", async () => {
    const f: Fixture = {
      clawbacks: [{ offer_id: OFFER, offer_version: 1, amount: "24.0000" }],
      lines: [line(PLAIN, "100.0000", "0.0000"), line(REWARD, "36.0000", "24.0000")],
      allLinesTotal: "136.0000",
      returnTotal: "112.0000",
    };
    expect([...(await loadReturnPromotionShares(fakeClient(f), RETURN_ID))]).toEqual([...(await loadReturnPromotionShares(fakeClient(f), RETURN_ID))]);
  });
});
