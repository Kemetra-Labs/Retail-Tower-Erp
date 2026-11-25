/**
 * RT-1598 — the independent redistribution validator: a negative-plan matrix (deliberately broken plans,
 * modelled on the eight broken plans of RT-1392 P1, but with this slice's own rules), plus positive controls.
 *
 * The validator recomputes buffer, floor and deficit from the raw rows on its own code path; it never calls
 * the engine. No database, no clock.
 */
import { finalizePlan } from "../../../src/inventory/redistribution/propose";
import type { RedistributionMoveV1, RedistributionViolationCodeV1 } from "../../../src/inventory/redistribution/types";
import { validateRedistributionPlan } from "../../../src/inventory/redistribution/validator/validate-plan";
import { OTHER_TENANT, P1, P2, S1, S2, S3, S4, move, problem, productId, row, store } from "./fixtures";

const P3 = productId(3);
const P4 = productId(4);
const S5 = "0e170000-0000-4000-8000-0000159ffff5";
const S9 = "0e170000-0000-4000-8000-0000159ffff9";

/**
 * S1: P1 surplus 19 (30 - 10 - 1), floor 11. S2: P1 deficit 8. S3: excluded (dead letter), long.
 * S4: inactive, short. S5: another tenant's store. P2 tracked. P3 kg at S1, each at S2. P4 sold only at S1.
 */
const base = problem(
  [
    store(S1),
    store(S2),
    store(S3, { eligibleAsSource: false, exclusion: "pos_queue_dead_letter_or_held" }),
    store(S4, { eligibleAsSource: false, exclusion: "inactive" }),
    store(S5, { tenantId: OTHER_TENANT }),
  ],
  [
    row(S1, P1, "30.0000", "10.0000"),
    row(S2, P1, "2.0000", "10.0000"),
    row(S3, P1, "50.0000", "10.0000"),
    row(S4, P1, "0.0000", "10.0000"),
    row(S5, P1, "0.0000", "10.0000"),
    row(S1, P2, "30.0000", "10.0000", { tracked: true }),
    row(S2, P2, "0.0000", "10.0000", { tracked: true }),
    row(S1, P3, "30.0000", "10.0000", { stockingUnit: "kg" }),
    row(S2, P3, "0.0000", "10.0000"),
    row(S1, P4, "30.0000", "10.0000"),
    row(S2, productId(5), "0.0000", null),
    row(S1, productId(5), "30.0000", null),
  ],
);

const codes = (moves: RedistributionMoveV1[]): RedistributionViolationCodeV1[] =>
  validateRedistributionPlan(base, moves).violations.map((v) => v.code);

describe("validator positive controls", () => {
  it("passes a correct plan and reports the deficit before and after", () => {
    const report = validateRedistributionPlan(base, [move(P1, S1, S2, "8.0000")]);
    // Deficit: S2 P1 8 + S2 P3 10 (each, untracked); the tracked, level-less and foreign rows do not count.
    expect(report).toEqual({ passed: true, violations: [], deficitBefore: "18.0000", deficitAfter: "10.0000" });
  });

  it("passes an empty plan", () => {
    expect(validateRedistributionPlan(base, [])).toMatchObject({ passed: true, deficitBefore: "18.0000", deficitAfter: "18.0000" });
  });

  it("passes a plan that leaves the source at exactly reorderLevel + buffer (inclusive floor)", () => {
    const p = problem([store(S1), store(S2)], [row(S1, P1, "20.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")]);
    expect(validateRedistributionPlan(p, [move(P1, S1, S2, "9.0000")]).passed).toBe(true);
  });

  it("counts open drafts at the source: a move that would be fine without them fails", () => {
    const p = problem(
      [store(S1), store(S2)],
      [row(S1, P1, "30.0000", "10.0000", { openOutboundDraft: "15.0000" }), row(S2, P1, "0.0000", "10.0000")],
    );
    // Floor 11; 30 - 15 = 15 left before the move: at most 4 may move.
    expect(validateRedistributionPlan(p, [move(P1, S1, S2, "4.0000")]).passed).toBe(true);
    expect(validateRedistributionPlan(p, [move(P1, S1, S2, "4.0001")]).violations.map((v) => v.code)).toEqual([
      "source_floor_breached",
    ]);
  });
});

describe("validator negative-plan matrix (every broken plan is rejected)", () => {
  const matrix: Array<[string, RedistributionMoveV1[], RedistributionViolationCodeV1]> = [
    ["leaves the source at exactly its reorder level", [move(P1, S1, S2, "20.0000")], "source_floor_breached"],
    ["leaves the source 0.0001 under reorderLevel + buffer", [move(P1, S1, S2, "19.0001")], "source_floor_breached"],
    ["drains the source below zero", [move(P1, S1, S2, "31.0000")], "source_floor_breached"],
    ["moves from an excluded store", [move(P1, S3, S2, "5.0000")], "excluded_source"],
    ["moves to an inactive store", [move(P1, S1, S4, "5.0000")], "inactive_destination"],
    ["moves a store to itself", [move(P1, S2, S2, "1.0000")], "self_move"],
    ["moves a zero quantity", [move(P1, S1, S2, "0.0000")], "non_positive_quantity"],
    ["moves a negative quantity", [move(P1, S1, S2, "-1.0000")], "non_positive_quantity"],
    ["raises the residual deficit (negative line)", [move(P1, S1, S2, "-1.0000")], "deficit_increased"],
    ["carries a malformed quantity", [move(P1, S1, S2, "8.00001")], "malformed_quantity"],
    ["moves to another tenant's store", [move(P1, S1, S5, "5.0000")], "tenant_mismatch"],
    ["names a store that is not in the problem", [move(P1, S1, S9, "5.0000")], "unknown_store"],
    ["names a stocking unit other than the rows'", [move(P1, S1, S2, "5.0000", "kg")], "stocking_unit_mismatch"],
    ["moves across stocking units (kg -> each)", [move(P3, S1, S2, "5.0000", "kg")], "stocking_unit_mismatch"],
    ["moves a tracked product", [move(P2, S1, S2, "5.0000")], "tracked_product"],
    ["moves a product the destination does not sell", [move(P4, S1, S2, "5.0000")], "not_sellable_at_destination"],
    ["moves a product the source does not sell", [move(P4, S2, S1, "5.0000")], "not_sellable_at_source"],
    ["moves a product with no reorder level", [move(productId(5), S1, S2, "5.0000")], "reorder_level_missing"],
    ["sends more than the destination's deficit", [move(P1, S1, S2, "9.0000")], "destination_overfilled"],
    ["repeats one (product, source, destination) line", [move(P1, S1, S2, "4.0000"), move(P1, S1, S2, "4.0000")], "duplicate_line"],
  ];

  it.each(matrix)("rejects a plan that %s", (_name, moves, code) => {
    expect(codes(moves)).toContain(code);
    expect(validateRedistributionPlan(base, moves).passed).toBe(false);
  });

  it("covers at least eight broken plans", () => {
    expect(matrix.length).toBeGreaterThanOrEqual(8);
  });

  it("rejects a store that is both a source and a destination of one product", () => {
    const p = problem(
      [store(S1), store(S2), store(S3)],
      [row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "30.0000", "10.0000"), row(S3, P1, "0.0000", "10.0000")],
    );
    expect(
      validateRedistributionPlan(p, [move(P1, S1, S2, "1.0000"), move(P1, S2, S3, "1.0000")]).violations.map((v) => v.code),
    ).toContain("store_both_source_and_destination");
  });

  it("rejects more than the transfer line limit on one (source, destination) pair", () => {
    const n = 101;
    const rows = Array.from({ length: n }, (_, i) => [
      row(S1, productId(i + 1), "30.0000", "10.0000"),
      row(S2, productId(i + 1), "0.0000", "10.0000"),
    ]).flat();
    const p = problem([store(S1), store(S2)], rows);
    const moves = Array.from({ length: n }, (_, i) => move(productId(i + 1), S1, S2, "1.0000"));
    const report = validateRedistributionPlan(p, moves);
    expect(report.violations).toEqual([
      { code: "transfer_too_many_lines", sourceStoreId: S1, destinationStoreId: S2, detail: "101 > 100" },
    ]);
    expect(validateRedistributionPlan(p, moves.slice(0, 100)).passed).toBe(true);
  });

  it("applies a lower line limit from the problem", () => {
    const p = problem(
      [store(S1), store(S2)],
      [P1, P2, P3].flatMap((pid) => [row(S1, pid, "30.0000", "10.0000"), row(S2, pid, "0.0000", "10.0000")]),
    );
    const limited = { ...p, limits: { ...p.limits, maxLinesPerTransfer: 2 } };
    const moves = [P1, P2, P3].map((pid) => move(pid, S1, S2, "1.0000"));
    expect(validateRedistributionPlan(limited, moves).violations.map((v) => v.code)).toEqual(["transfer_too_many_lines"]);
  });

  it("falls back to the W3 limit of 100 when the problem's line limit is invalid", () => {
    const p = { ...base, limits: { ...base.limits, maxLinesPerTransfer: 0 } };
    expect(validateRedistributionPlan(p, [move(P1, S1, S2, "8.0000")]).passed).toBe(true);
  });

  it("rejects a duplicate store instead of letting a later entry re-list an excluded store as eligible", () => {
    const p = problem(
      [store(S1, { eligibleAsSource: false, exclusion: "pos_queue_dead_letter_or_held" }), store(S1), store(S2)],
      [row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")],
    );
    const report = validateRedistributionPlan(p, [move(P1, S1, S2, "5.0000")]);
    expect(report.passed).toBe(false);
    expect(report.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining(["input_duplicate_store", "excluded_source"]),
    );
  });

  it("rejects a duplicate row instead of letting a later entry hide a floor breach", () => {
    const p = problem(
      [store(S1), store(S2)],
      [row(S1, P1, "0.0000", "10.0000"), row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")],
    );
    const report = validateRedistributionPlan(p, [move(P1, S1, S2, "5.0000")]);
    expect(report.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining(["input_duplicate_row", "source_floor_breached"]),
    );
  });

  it("rejects a row of a store that is not in the problem", () => {
    const p = problem([store(S1), store(S2)], [row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000"), row(S9, P1, "0.0000", "10.0000")]);
    expect(validateRedistributionPlan(p, []).violations).toEqual([{ code: "input_unknown_store", storeId: S9, productId: P1 }]);
  });

  it("does not trust malformed rows: a move over a malformed row is rejected", () => {
    const p = problem([store(S1), store(S2)], [row(S1, P1, "abc", "10.0000"), row(S2, P1, "0.0000", "10.0000")]);
    expect(validateRedistributionPlan(p, [move(P1, S1, S2, "1.0000")]).violations.map((v) => v.code)).toContain(
      "input_malformed_quantity",
    );
  });

  it("rejects a buffer minimum below one stocking unit (a source could otherwise end at exactly its level)", () => {
    const p = problem([store(S1), store(S2)], [row(S1, P1, "20.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")], {
      buffer: { minimum: "0.0000", percentOfReorderLevel: 0, rounding: "scale" },
    });
    expect(validateRedistributionPlan(p, [move(P1, S1, S2, "10.0000")]).violations.map((v) => v.code)).toEqual([
      "input_invalid_buffer_policy",
    ]);
  });

  it("rejects a plan whose buffer policy is malformed instead of guessing a buffer", () => {
    const p = { ...base, buffer: { minimum: "x", percentOfReorderLevel: 10, rounding: "scale" as const } };
    expect(validateRedistributionPlan(p, [move(P1, S1, S2, "8.0000")]).violations.map((v) => v.code)).toContain(
      "input_invalid_buffer_policy",
    );
  });
});

describe("finalizePlan (the engine/validator join)", () => {
  const simple = problem([store(S1), store(S2)], [row(S1, P1, "30.0000", "10.0000"), row(S2, P1, "2.0000", "10.0000")]);
  const planned = (moves: RedistributionMoveV1[], deficitAfter: string) => ({
    kind: "planned" as const,
    startedAt: 0,
    moves,
    objective: { deficitBefore: "8.0000", deficitAfter, storePairs: 1, lines: moves.length },
    warnings: [],
  });

  it("turns an engine plan the validator rejects into status invalid with no moves", () => {
    const r = finalizePlan(simple, planned([move(P1, S1, S2, "20.0000")], "0.0000"), () => 0);
    expect(r).toMatchObject({ status: "invalid", moves: [], objective: null, validator: { passed: false } });
    expect(r.validator?.violations.map((v) => v.code)).toContain("source_floor_breached");
  });

  it("rejects an engine plan whose objective disagrees with the validator's recomputation", () => {
    const r = finalizePlan(simple, planned([move(P1, S1, S2, "8.0000")], "1.0000"), () => 0);
    expect(r.status).toBe("invalid");
    expect(r.validator?.violations).toEqual([
      {
        code: "objective_mismatch",
        detail: "engine 8.0000 -> 1.0000, 1 pairs, 1 lines; validator 8.0000 -> 0.0000, 1 pairs, 1 lines",
      },
    ]);
  });

  it("rejects an engine plan whose store-pair or line count disagrees with its moves", () => {
    const good = planned([move(P1, S1, S2, "8.0000")], "0.0000");
    expect(finalizePlan(simple, good, () => 0).status).toBe("proposed");
    for (const objective of [
      { ...good.objective, storePairs: 2 },
      { ...good.objective, lines: 2 },
    ]) {
      const r = finalizePlan(simple, { ...good, objective }, () => 0);
      expect(r.validator?.violations.map((v) => v.code)).toEqual(["objective_mismatch"]);
    }
  });
});
