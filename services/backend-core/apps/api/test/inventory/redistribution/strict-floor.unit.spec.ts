/**
 * RT-1598 — `SOURCE_FLOOR_INCLUSIVE` is one switch for both sides. The owner kept the floor inclusive
 * (2026-11-25); this spec proves that flipping it makes the engine AND the validator strict together, so the
 * two never disagree whichever way the constant is set.
 */
import type * as Propose from "../../../src/inventory/redistribution/propose";
import type * as Validate from "../../../src/inventory/redistribution/validator/validate-plan";
import { P1, S1, S2, int, mulberry32, problem, row, store, syntheticProblem } from "./fixtures";

const POLICY = "../../../src/inventory/redistribution/policy";

function loadStrict(): { propose: typeof Propose; validate: typeof Validate } {
  let loaded: { propose: typeof Propose; validate: typeof Validate } | undefined;
  jest.isolateModules(() => {
    jest.doMock(POLICY, () => ({ ...jest.requireActual(POLICY), SOURCE_FLOOR_INCLUSIVE: false }));
    loaded = {
      propose: require("../../../src/inventory/redistribution/propose") as typeof Propose,
      validate: require("../../../src/inventory/redistribution/validator/validate-plan") as typeof Validate,
    };
  });
  return loaded!;
}

describe("strict source floor (SOURCE_FLOOR_INCLUSIVE = false)", () => {
  afterEach(() => jest.dontMock(POLICY));

  it("leaves the source strictly above reorderLevel + buffer, and the validator agrees", () => {
    const { propose, validate } = loadStrict();
    const p = problem([store(S1), store(S2)], [row(S1, P1, "20.0000", "10.0000"), row(S2, P1, "0.0000", "10.0000")]);
    const r = propose.proposeRedistribution(p);
    // Inclusive would move 9.0000 (ending at exactly 11); strict moves one 0.0001 less.
    expect(r.status).toBe("proposed");
    expect(r.moves.map((m) => m.quantity)).toEqual(["8.9999"]);
    const exact = validate.validateRedistributionPlan(p, [{ ...r.moves[0]!, quantity: "9.0000" }]);
    expect(exact.violations.map((v) => v.code)).toEqual(["source_floor_breached"]);
  });

  it("every strict engine output passes the strict validator (seeded cases)", () => {
    const { propose } = loadStrict();
    const rng = mulberry32(0x1598_5701);
    for (let i = 0; i < 100; i++) {
      const p = syntheticProblem(rng, { stores: int(rng, 2, 8), products: int(rng, 1, 10), density: 0.85 });
      const r = propose.proposeRedistribution(p);
      expect(r.validator).toEqual({ passed: true, violations: [] });
    }
  });
});
