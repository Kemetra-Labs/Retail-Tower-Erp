/**
 * RT-1598 — seeded generative cases for the redistribution engine. fast-check is not a Backend-Core
 * dependency (adding it would be a gated lockfile change), so, as in
 * `pricing/resolution/resolve.property.unit.spec.ts`, the cases come from a seeded PRNG (mulberry32): every
 * run checks the same cases, and a failure names its seed and case index so it can be replayed.
 *
 * Synthetic tenants only. The RT-1392 lane-cost fixtures and optima are deliberately NOT used: stage 1 has no
 * lane costs and makes no optimality claim (plan P-9).
 */
import { proposeRedistribution } from "../../../src/inventory/redistribution/propose";
import type { RedistributionProblemV1, RedistributionResultV1 } from "../../../src/inventory/redistribution/types";
import { validateRedistributionPlan } from "../../../src/inventory/redistribution/validator/validate-plan";
import { type Rng, int, mulberry32, shuffle, syntheticProblem } from "./fixtures";

const SEED = 0x1598_0a01;
const CASES = 300;

function forEachCase(seed: number, check: (p: RedistributionProblemV1, rng: Rng) => void): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < CASES; i++) {
    const p = syntheticProblem(rng, { stores: int(rng, 2, 9), products: int(rng, 1, 12), density: 0.85 });
    try {
      check(p, rng);
    } catch (err) {
      throw new Error(`seed ${seed} case ${i}: ${(err as Error).message}`);
    }
  }
}

/** A third, test-only computation of the best achievable residual deficit when no pair limit binds. */
function bestResidualDeficit(p: RedistributionProblemV1): bigint {
  const toScaled = (q: string): bigint => {
    const neg = q.startsWith("-");
    const [w, f = ""] = (neg ? q.slice(1) : q).split(".");
    const v = BigInt(w!) * 10_000n + BigInt(f.padEnd(4, "0"));
    return neg ? -v : v;
  };
  const stores = new Map(p.stores.map((s) => [s.storeId, s]));
  const groups = new Map<string, { surplus: bigint; deficit: bigint }>();
  for (const r of p.rows) {
    const s = stores.get(r.storeId)!;
    if (r.tracked || r.reorderLevel === null || s.exclusion === "inactive") continue;
    const key = `${r.productId}|${r.stockingUnit}`;
    const g = groups.get(key) ?? { surplus: 0n, deficit: 0n };
    const level = toScaled(r.reorderLevel);
    const tenth = (level * 10n + 99n) / 100n;
    const buffer = tenth > 10_000n ? tenth : 10_000n;
    const ats = toScaled(r.availableToSell);
    if (s.eligibleAsSource && s.exclusion === undefined) {
      const surplus = ats - level - buffer - toScaled(r.openOutboundDraft);
      if (surplus > 0n) g.surplus += surplus;
    }
    const deficit = level - ats - toScaled(r.openInbound);
    if (deficit > 0n) g.deficit += deficit;
    groups.set(key, g);
  }
  let residual = 0n;
  for (const g of groups.values()) residual += g.deficit > g.surplus ? g.deficit - g.surplus : 0n;
  return residual;
}

const scaled = (q: string): bigint => {
  const [w, f = ""] = q.split(".");
  return BigInt(w!) * 10_000n + BigInt(f.padEnd(4, "0"));
};

describe("reorder_gap_greedy generative properties", () => {
  it("every engine output passes the independent validator, and its objective matches the validator's", () => {
    let proposed = 0;
    forEachCase(SEED, (p) => {
      const r = proposeRedistribution(p);
      expect(["proposed", "nothing_to_move"]).toContain(r.status);
      expect(r.validator).toEqual({ passed: true, violations: [] });
      const again = validateRedistributionPlan(p, r.moves);
      expect(again.passed).toBe(true);
      expect(r.objective).toMatchObject({ deficitBefore: again.deficitBefore, deficitAfter: again.deficitAfter });
      if (r.status === "proposed") proposed++;
    });
    // The generator must actually exercise the allocation path, not only the empty one.
    expect(proposed).toBeGreaterThan(CASES / 2);
  });

  it("is deterministic under any order of stores and rows", () => {
    forEachCase(SEED + 1, (p, rng) => {
      const first = proposeRedistribution(p);
      expect(proposeRedistribution(p)).toEqual(first);
      expect(proposeRedistribution({ ...p, stores: shuffle(rng, p.stores), rows: shuffle(rng, p.rows) })).toEqual(first);
    });
  });

  it("leaves the smallest residual deficit available without pair limits (objective 1)", () => {
    forEachCase(SEED + 2, (p) => {
      const r = proposeRedistribution(p);
      expect(scaled(r.objective!.deficitAfter)).toBe(bestResidualDeficit(p));
    });
  });

  it("keeps every result well formed: positive quantities, one line per (product, source, destination), counts agree", () => {
    forEachCase(SEED + 3, (p) => {
      const r: RedistributionResultV1 = proposeRedistribution(p);
      const keys = new Set(r.moves.map((m) => `${m.productId}|${m.sourceStoreId}|${m.destinationStoreId}`));
      expect(keys.size).toBe(r.moves.length);
      for (const m of r.moves) expect(scaled(m.quantity)).toBeGreaterThan(0n);
      const pairs = new Set(r.moves.map((m) => `${m.sourceStoreId}|${m.destinationStoreId}`));
      expect(r.objective).toMatchObject({ lines: r.moves.length, storePairs: pairs.size });
    });
  });

  it("still validates with a tight pair line limit (the limit binds and the engine routes around it)", () => {
    forEachCase(SEED + 4, (p) => {
      const tight = { ...p, limits: { ...p.limits, maxLinesPerTransfer: 1 } };
      const r = proposeRedistribution(tight);
      expect(r.validator).toEqual({ passed: true, violations: [] });
    });
  });
});
