/**
 * RT-1598 — the W9 redistribution engine (`reorder_gap_greedy`), hand-checked tiny cases.
 *
 * Every expected number below is worked out by hand from the owner formulas (P-1, P-10):
 *   buffer  = max(1 unit, 10% of reorderLevel), rounded up at the 0.0001 scale;
 *   surplus = max(0, ATS - reorderLevel - buffer - openOutboundDraft);
 *   deficit = max(0, reorderLevel - ATS - openInbound).
 * No database, no clock (a fake `now` is injected where the deadline matters).
 */
import { bufferOf, planReorderGapGreedy } from "../../../src/inventory/redistribution/engine/reorder-gap-greedy";
import { DEFAULT_BUFFER_POLICY_V1, TRANSFER_LINE_MAX } from "../../../src/inventory/redistribution/policy";
import { proposeRedistribution } from "../../../src/inventory/redistribution/propose";
import { parseQty } from "../../../src/inventory/redistribution/quantity";
import type { RedistributionProblemV1 } from "../../../src/inventory/redistribution/types";
import { TRANSFER_LINE_MAX as W3_TRANSFER_LINE_MAX } from "../../../src/inventory/shipment-transfers/shipment-transfer.rules";
import {
  OTHER_TENANT,
  P1,
  P2,
  S1,
  S2,
  S3,
  S4,
  TENANT,
  mulberry32,
  problem,
  productId,
  row,
  shuffle,
  store,
} from "./fixtures";

const stores4 = [store(S1), store(S2), store(S3), store(S4)];
const moveOf = (pid: string, src: string, dst: string, quantity: string, warnings: string[] = []) => ({
  productId: pid,
  sourceStoreId: src,
  destinationStoreId: dst,
  quantity,
  stockingUnit: "each",
  warnings,
});

describe("bufferOf (P-10)", () => {
  const b = (level: string, policy = DEFAULT_BUFFER_POLICY_V1) => bufferOf(parseQty(level)!, policy);

  it("is at least one stocking unit", () => {
    expect(b("0.0000")).toBe(10_000n);
    expect(b("10.0000")).toBe(10_000n);
  });

  it("is 10% of the reorder level above ten units, exact at the 0.0001 scale", () => {
    expect(b("50.0000")).toBe(50_000n);
    expect(b("15.0000")).toBe(15_000n);
  });

  it("rounds a fractional 10% up (toward protecting the source), never down", () => {
    expect(b("0.0015", { minimum: "0.0000", percentOfReorderLevel: 10, rounding: "scale" })).toBe(2n);
    expect(b("15.0001", { minimum: "0.0000", percentOfReorderLevel: 10, rounding: "scale" })).toBe(15_001n);
  });

  it("rounds up to a whole stocking unit when the policy says so", () => {
    expect(b("15.0000", { ...DEFAULT_BUFFER_POLICY_V1, rounding: "whole_unit" })).toBe(20_000n);
    expect(b("30.0000", { ...DEFAULT_BUFFER_POLICY_V1, rounding: "whole_unit" })).toBe(30_000n);
  });
});

describe("reorder_gap_greedy, hand-checked tiny cases", () => {
  it("moves the deficit from the one surplus store (surplus 19, deficit 8)", () => {
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "2.0000", "10.0000")]));
    expect(r.status).toBe("proposed");
    expect(r.rule).toEqual({ name: "reorder_gap_greedy", version: "1.0.0" });
    expect(r.moves).toEqual([moveOf(P1, S1, S2, "8.0000")]);
    expect(r.objective).toEqual({ deficitBefore: "8.0000", deficitAfter: "0.0000", storePairs: 1, lines: 1 });
    expect(r.validator).toEqual({ passed: true, violations: [] });
  });

  it("never takes the source below reorderLevel + buffer, and warns inside the near zone", () => {
    // S1: surplus = 20 - 10 - 1 = 9; S2: deficit 10. The move leaves S1 at exactly 11 = level + buffer.
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "20.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")]));
    expect(r.moves).toEqual([moveOf(P1, S1, S2, "9.0000", ["source_near_reorder_level"])]);
    expect(r.objective).toMatchObject({ deficitBefore: "10.0000", deficitAfter: "1.0000" });
  });

  it("uses the 10% buffer above ten units and warns up to level + 2 x buffer", () => {
    // level 50: buffer 5. S1: surplus = 70 - 50 - 5 = 15, end 55 (<= 60 -> warn). S2: deficit 40.
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "70.0000", "50.0000"), row(S2, P1, "10.0000", "50.0000")]));
    expect(r.moves).toEqual([moveOf(P1, S1, S2, "15.0000", ["source_near_reorder_level"])]);
  });

  it("does not warn when the source ends above level + 2 x buffer", () => {
    // level 10, buffer 1: S1 ends 30 - 8 = 22 > 12.
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "2.0000", "10.0000")]));
    expect(r.moves[0]!.warnings).toEqual([]);
  });

  it("warns at the upper edge of the near zone (end exactly level + 2 x buffer)", () => {
    // level 10, buffer 1: S1 surplus 11; S2 deficit 9 -> S1 ends 21 - 9 = 12 = level + 2.
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "21.0000", "10.0000"), row(S2, P1, "1.0000", "10.0000")]));
    expect(r.moves).toEqual([moveOf(P1, S1, S2, "9.0000", ["source_near_reorder_level"])]);
  });

  it("keeps a fractional buffer exact (level 15 -> buffer 1.5 -> surplus 13.5)", () => {
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "30.0000", "15.0000"), row(S2, P1, "0.0000", "15.0000")]));
    expect(r.moves.map((m) => m.quantity)).toEqual(["13.5000"]);
  });

  it("whole-unit rounding of the buffer gives whole moves for whole inputs (buffer 2 -> surplus 13)", () => {
    const p = problem(stores4, [row(S1, P1, "30.0000", "15.0000"), row(S2, P1, "0.0000", "15.0000")], {
      buffer: { ...DEFAULT_BUFFER_POLICY_V1, rounding: "whole_unit" },
    });
    expect(proposeRedistribution(p).moves.map((m) => m.quantity)).toEqual(["13.0000"]);
  });

  it("nets open outbound drafts out of surplus and open inbound out of deficit", () => {
    // S1: 30 - 10 - 1 - 5 = 14; S2: 10 - 2 - 3 = 5.
    const r = proposeRedistribution(
      problem(stores4, [
        row(S1, P1, "30.0000", "10.0000", { openOutboundDraft: "5.0000" }),
        row(S2, P1, "2.0000", "10.0000", { openInbound: "3.0000" }),
      ]),
    );
    expect(r.moves).toEqual([moveOf(P1, S1, S2, "5.0000")]);
    expect(r.objective).toMatchObject({ deficitBefore: "5.0000", deficitAfter: "0.0000" });
  });

  it("serves the largest deficit first from the largest surplus first", () => {
    // S1 surplus 4 (15-10-1), S2 surplus 9 (20-10-1); S3 deficit 3, S4 deficit 7.
    const r = proposeRedistribution(
      problem(stores4, [
        row(S1, P1, "15.0000", "10.0000"),
        row(S2, P1, "20.0000", "10.0000"),
        row(S3, P1, "7.0000", "10.0000"),
        row(S4, P1, "3.0000", "10.0000"),
      ]),
    );
    // S4 (7) from S2 (9) -> S2 has 2 left; S3 (3): S2 already paired with S4 only, so largest surplus S1 (4).
    // S1 ends 12 = level + 2 x buffer (warn); S2 ends 13 (no warning).
    expect(r.moves).toEqual([moveOf(P1, S1, S3, "3.0000", ["source_near_reorder_level"]), moveOf(P1, S2, S4, "7.0000")]);
    expect(r.objective).toEqual({ deficitBefore: "10.0000", deficitAfter: "0.0000", storePairs: 2, lines: 2 });
  });

  it("splits one deficit over several sources when one is not enough", () => {
    // S1 surplus 4, S2 surplus 3 (14-10-1); S3 deficit 6 -> 4 from S1, then 2 from S2.
    const r = proposeRedistribution(
      problem(stores4, [
        row(S1, P1, "15.0000", "10.0000"),
        row(S2, P1, "14.0000", "10.0000"),
        row(S3, P1, "4.0000", "10.0000"),
      ]),
    );
    expect(r.moves).toEqual([
      moveOf(P1, S1, S3, "4.0000", ["source_near_reorder_level"]),
      moveOf(P1, S2, S3, "2.0000", ["source_near_reorder_level"]),
    ]);
  });

  it("prefers a store pair already chosen over a larger surplus (fewer pairs)", () => {
    const r = proposeRedistribution(
      problem(stores4, [
        // P1: S2 has the larger surplus (15 vs 10), so S2 -> S3 is chosen.
        row(S1, P1, "21.0000", "10.0000"),
        row(S2, P1, "26.0000", "10.0000"),
        row(S3, P1, "5.0000", "10.0000"),
        // P2: S1 has the larger surplus (20 vs 6), but the pair S2 -> S3 already exists.
        row(S1, P2, "31.0000", "10.0000"),
        row(S2, P2, "17.0000", "10.0000"),
        row(S3, P2, "5.0000", "10.0000"),
      ]),
    );
    expect(r.moves.map((m) => [m.productId, m.sourceStoreId, m.destinationStoreId, m.quantity])).toEqual([
      [P1, S2, S3, "5.0000"],
      [P2, S2, S3, "5.0000"],
    ]);
    expect(r.objective?.storePairs).toBe(1);
  });

  it("breaks ties on store id: equal surpluses -> lower source id; equal deficits -> lower destination id", () => {
    const r = proposeRedistribution(
      problem(stores4, [
        row(S2, P1, "18.0000", "10.0000"), // surplus 7
        row(S1, P1, "18.0000", "10.0000"), // surplus 7
        row(S4, P1, "5.0000", "10.0000"), // deficit 5
        row(S3, P1, "5.0000", "10.0000"), // deficit 5
      ]),
    );
    // S3 (lower id) first, from S1 (lower id); S4 then prefers no existing pair, largest surplus S2 (7 vs 2).
    expect(r.moves.map((m) => [m.sourceStoreId, m.destinationStoreId, m.quantity])).toEqual([
      [S1, S3, "5.0000"],
      [S2, S4, "5.0000"],
    ]);
  });

  it("returns nothing_to_move when no store is short", () => {
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "10.0000", "10.0000")]));
    expect(r).toMatchObject({ status: "nothing_to_move", moves: [], validator: { passed: true, violations: [] } });
    expect(r.objective).toEqual({ deficitBefore: "0.0000", deficitAfter: "0.0000", storePairs: 0, lines: 0 });
  });

  it("returns nothing_to_move when the short store has no counterpart with surplus", () => {
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "11.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")]));
    expect(r.status).toBe("nothing_to_move");
    expect(r.objective).toMatchObject({ deficitBefore: "10.0000", deficitAfter: "10.0000" });
  });
});

describe("eligibility", () => {
  it("never uses an excluded store as a source, but it may still receive", () => {
    const stores = [store(S1, { eligibleAsSource: false, exclusion: "pos_queue_unknown" }), store(S2), store(S3)];
    const r = proposeRedistribution(
      problem(stores, [
        row(S1, P1, "90.0000", "10.0000"), // big surplus, but excluded as a source
        row(S2, P1, "0.0000", "10.0000"),
        row(S1, P2, "0.0000", "10.0000"), // excluded store, short: may receive
        row(S3, P2, "40.0000", "10.0000"),
      ]),
    );
    expect(r.moves.map((m) => [m.productId, m.sourceStoreId, m.destinationStoreId])).toEqual([[P2, S3, S1]]);
    expect(r.warnings).toContainEqual({ code: "store_excluded_as_source", storeId: S1, detail: "pos_queue_unknown" });
  });

  it("never uses a store with eligibleAsSource=false as a source, even without an exclusion reason", () => {
    const stores = [store(S1, { eligibleAsSource: false }), store(S2)];
    const r = proposeRedistribution(problem(stores, [row(S1, P1, "90.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")]));
    expect(r.status).toBe("nothing_to_move");
    expect(r.warnings).toContainEqual({ code: "store_excluded_as_source", storeId: S1 });
  });

  it("never sends stock to an inactive store", () => {
    const stores = [store(S1), store(S2, { eligibleAsSource: false, exclusion: "inactive" })];
    const r = proposeRedistribution(problem(stores, [row(S1, P1, "90.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")]));
    expect(r.status).toBe("nothing_to_move");
    expect(r.objective?.deficitBefore).toBe("0.0000");
  });

  it("skips tracked rows, rows without a reorder level, and moves across stocking units", () => {
    const r = proposeRedistribution(
      problem(stores4, [
        row(S1, P1, "90.0000", "10.0000", { tracked: true }),
        row(S2, P1, "0.0000", "10.0000"),
        row(S1, P2, "90.0000", null),
        row(S2, P2, "0.0000", "10.0000"),
        row(S3, productId(3), "90.0000", "10.0000", { stockingUnit: "kg" }),
        row(S4, productId(3), "0.0000", "10.0000"),
      ]),
    );
    expect(r.status).toBe("nothing_to_move");
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        { code: "tracked_product_skipped", storeId: S1, count: 1 },
        { code: "reorder_level_missing", storeId: S1, count: 1 },
        { code: "stocking_unit_mismatch", productId: productId(3) },
      ]),
    );
  });

  it("does not move a product sellable at only one store", () => {
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "90.0000", "10.0000"), row(S2, P2, "0.0000", "10.0000")]));
    expect(r.status).toBe("nothing_to_move");
  });

  it("counts a negative ATS as a deficit and warns about it", () => {
    // S2: deficit = 2 - (-3) - 0 = 5.
    const r = proposeRedistribution(problem(stores4, [row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "-3.0000", "2.0000")]));
    expect(r.moves).toEqual([moveOf(P1, S1, S2, "5.0000")]);
    expect(r.warnings).toContainEqual({ code: "negative_available_to_sell", storeId: S2, count: 1 });
  });

  it("keeps a (source, destination) pair within the transfer line limit and uses another source beyond it", () => {
    const rows = [1, 2, 3].flatMap((n) => [
      row(S1, productId(n), "30.0000", "10.0000"),
      row(S2, productId(n), "0.0000", "10.0000"),
    ]);
    rows.push(row(S3, productId(3), "30.0000", "10.0000"));
    const p = problem([store(S1), store(S2), store(S3)], rows);
    const r = proposeRedistribution({ ...p, limits: { ...p.limits, maxLinesPerTransfer: 2 } });
    expect(r.moves.map((m) => [m.productId, m.sourceStoreId])).toEqual([
      [productId(1), S1],
      [productId(2), S1],
      [productId(3), S3],
    ]);
    expect(r.validator?.passed).toBe(true);
  });
});

describe("determinism", () => {
  const base = problem(stores4, [
    row(S1, P1, "21.0000", "10.0000"),
    row(S2, P1, "26.0000", "10.0000"),
    row(S3, P1, "5.0000", "10.0000"),
    row(S4, P1, "1.0000", "10.0000"),
    row(S1, P2, "31.0000", "10.0000"),
    row(S2, P2, "17.0000", "10.0000"),
    row(S3, P2, "5.0000", "10.0000"),
    row(S4, P2, "6.5000", "10.0000", { openInbound: "1.0000" }),
  ]);

  it("gives the same result for the same input", () => {
    expect(proposeRedistribution(base)).toEqual(proposeRedistribution(base));
  });

  it("gives the same result whatever the order of the stores and rows", () => {
    const first = proposeRedistribution(base);
    const rng = mulberry32(0x1598_0001);
    for (let i = 0; i < 50; i++) {
      const shuffled: RedistributionProblemV1 = { ...base, stores: shuffle(rng, base.stores), rows: shuffle(rng, base.rows) };
      expect(proposeRedistribution(shuffled)).toEqual(first);
    }
  });
});

describe("limits, deadline and malformed input", () => {
  const two = problem([store(S1), store(S2)], [row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")]);

  it("refuses too many stores or rows before computing anything", () => {
    for (const limits of [
      { ...two.limits, maxStores: 1 },
      { ...two.limits, maxRows: 1 },
    ]) {
      expect(proposeRedistribution({ ...two, limits })).toEqual({
        status: "refused_too_large",
        rule: { name: "reorder_gap_greedy", version: "1.0.0" },
        moves: [],
        objective: null,
        validator: null,
        warnings: [],
      });
    }
  });

  it("refuses a tenant whose total deficit would not fit numeric(19,4) (the objective is a Qty too)", () => {
    const huge = (sid: string) => row(sid, P1, "-999999999999999.0000", "999999999999999.0000");
    const p = problem([store(S1), store(S2), store(S3)], [huge(S1), huge(S2), huge(S3)]);
    expect(proposeRedistribution(p).status).toBe("refused_too_large");
    // A single row can overflow too: level - ATS = 1999999999999998 (16 integer digits).
    expect(proposeRedistribution(problem([store(S1)], [huge(S1)])).status).toBe("refused_too_large");
    const fits = row(S1, P1, "0.0000", "999999999999999.0000");
    expect(proposeRedistribution(problem([store(S1)], [fits])).status).toBe("nothing_to_move");
  });

  it("returns deadline_exceeded, never a partial result, when the clock passes the deadline", () => {
    let t = 0;
    const now = () => (t += 1000);
    const r = proposeRedistribution({ ...two, limits: { ...two.limits, deadlineMs: 1 } }, { now });
    expect(r).toMatchObject({ status: "deadline_exceeded", moves: [], objective: null, validator: null });
  });

  it("checks the deadline between products", () => {
    const rows = Array.from({ length: 3000 }, (_, i) => [
      row(S1, productId(i + 1), "30.0000", "10.0000"),
      row(S2, productId(i + 1), "0.0000", "10.0000"),
    ]).flat();
    let calls = 0;
    const now = () => (++calls > 2500 ? 10_000 : 0);
    const p = problem([store(S1), store(S2)], rows);
    expect(proposeRedistribution(p, { now }).status).toBe("deadline_exceeded");
    expect(planReorderGapGreedy(p, { now: () => 0 }).kind).toBe("planned");
  });

  it("checks the deadline inside one product's allocation loop (every 1024 steps)", () => {
    // One product, 1200 sources of surplus 1 and 1200 destinations of deficit 1: 1200 allocation steps.
    const ids = Array.from({ length: 2400 }, (_, i) => `store-${String(i).padStart(5, "0")}`);
    const rows = ids.map((id, i) => row(id, P1, i < 1200 ? "12.0000" : "9.0000", "10.0000"));
    const p = problem(ids.map((id) => store(id)), rows, {
      limits: { maxStores: 2400, maxRows: 2400, deadlineMs: 5000, maxLinesPerTransfer: 100 },
    });
    let calls = 0;
    // Clock reads: 1 = start, 2 = the product, 3 = step 1024.
    expect(planReorderGapGreedy(p, { now: () => (++calls > 2 ? 10_000 : 0) }).kind).toBe("deadline_exceeded");
    expect(calls).toBe(3);
  });

  it("checks the deadline once more after validation", () => {
    let calls = 0;
    // Clock reads: 1 = start, 2 = the product, 3 = after the validator.
    const r = proposeRedistribution(two, { now: () => (++calls >= 3 ? 10_000 : 0) });
    expect(r.status).toBe("deadline_exceeded");
    expect(calls).toBe(3);
  });

  it("returns invalid with input violations for malformed problems (no throw)", () => {
    const cases: Array<[RedistributionProblemV1, string]> = [
      [{ ...two, version: 2 as 1 }, "input_unsupported_problem"],
      [{ ...two, limits: { ...two.limits, maxLinesPerTransfer: 101 } }, "input_invalid_limits"],
      [{ ...two, limits: { ...two.limits, deadlineMs: 0 } }, "input_invalid_limits"],
      [{ ...two, buffer: { minimum: "1.0000", percentOfReorderLevel: 101, rounding: "scale" } }, "input_invalid_buffer_policy"],
      [{ ...two, buffer: { minimum: "-1.0000", percentOfReorderLevel: 10, rounding: "scale" } }, "input_invalid_buffer_policy"],
      [{ ...two, buffer: { minimum: "1.0000", percentOfReorderLevel: 10, rounding: "up" as "scale" } }, "input_invalid_buffer_policy"],
      [{ ...two, stores: [store(S1), store(S1)] }, "input_duplicate_store"],
      [{ ...two, stores: [store(S1), store(S2, { tenantId: OTHER_TENANT })] }, "input_tenant_mismatch"],
      [{ ...two, rows: [...two.rows, row(S3, P1, "1.0000", "1.0000")] }, "input_unknown_store"],
      [{ ...two, rows: [...two.rows, row(S1, P1, "1.0000", "1.0000")] }, "input_duplicate_row"],
      [{ ...two, rows: [row(S1, P1, "3.14159", "10.0000")] }, "input_malformed_quantity"],
      [{ ...two, rows: [row(S1, P1, "1234567890123456.0000", "10.0000")] }, "input_malformed_quantity"],
      [{ ...two, rows: [row(S1, P1, "30.0000", "-1.0000")] }, "input_malformed_quantity"],
      [{ ...two, rows: [row(S1, P1, "30.0000", "10.0000", { openOutboundDraft: "-1.0000" })] }, "input_malformed_quantity"],
      [{ ...two, rows: [row(S1, P1, "30.0000", "10.0000", { openInbound: "x" })] }, "input_malformed_quantity"],
    ];
    for (const [p, code] of cases) {
      const r = proposeRedistribution(p);
      expect(r).toMatchObject({ status: "invalid", moves: [], objective: null, warnings: [] });
      expect(r.validator?.passed).toBe(false);
      expect(r.validator?.violations.map((v) => v.code)).toContain(code);
    }
    expect(TENANT).not.toBe(OTHER_TENANT);
  });
});

describe("policy constants", () => {
  it("mirrors the W3 transfer line limit (the engine may not import W3 rules: they load Nest)", () => {
    expect(TRANSFER_LINE_MAX).toBe(W3_TRANSFER_LINE_MAX);
  });
});
