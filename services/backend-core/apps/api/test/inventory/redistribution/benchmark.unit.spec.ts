/**
 * RT-1598 AC5 — performance benchmark at the P-6 caps (50 stores, 20,000 rows), recorded against the D-3
 * budget: p95 compute <= 5 s and <= 256 MB per run.
 *
 * Seeded synthetic tenants only. The assertion is the budget itself, which leaves wide headroom over the
 * measured numbers, so a slow CI runner does not make it flaky. The measured p95 and heap figures are printed
 * (one line) for the RT-1598 evidence comment.
 */
import { DEFAULT_LIMITS_V1 } from "../../../src/inventory/redistribution/policy";
import { proposeRedistribution } from "../../../src/inventory/redistribution/propose";
import { mulberry32, syntheticProblem } from "./fixtures";

const BUDGET_P95_MS = 5000;
const BUDGET_BYTES = 256 * 1024 * 1024;
const RUNS = 15;

describe("redistribution benchmark at the caps (D-3 budget)", () => {
  it("computes 50 stores x 400 products (20,000 rows) within p95 5 s and 256 MB", () => {
    const tenants = [0x1598_b001, 0x1598_b002, 0x1598_b003].map((seed) =>
      syntheticProblem(mulberry32(seed), { stores: DEFAULT_LIMITS_V1.maxStores, products: 400, density: 1 }),
    );
    for (const t of tenants) expect(t.rows.length).toBe(DEFAULT_LIMITS_V1.maxRows);

    const durations: number[] = [];
    let peakHeapDelta = 0;
    let lines = 0;
    for (let i = 0; i < RUNS; i++) {
      const tenant = tenants[i % tenants.length]!;
      const heapBefore = process.memoryUsage().heapUsed;
      const t0 = process.hrtime.bigint();
      const r = proposeRedistribution(tenant);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      peakHeapDelta = Math.max(peakHeapDelta, process.memoryUsage().heapUsed - heapBefore);
      durations.push(ms);
      expect(r.status).toBe("proposed");
      lines = r.moves.length;
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(0.95 * durations.length) - 1]!;
    const rss = process.memoryUsage().rss;
    // Evidence line for RT-1598 (D-3): p95, worst, peak heap growth during one run, process RSS.
    console.log(
      `RT-1598 benchmark: runs=${RUNS} rows=20000 stores=50 p95=${p95.toFixed(1)}ms max=${durations.at(-1)!.toFixed(1)}ms ` +
        `peakHeapDelta=${(peakHeapDelta / 1048576).toFixed(1)}MB rss=${(rss / 1048576).toFixed(1)}MB lastLines=${lines}`,
    );
    expect(p95).toBeLessThanOrEqual(BUDGET_P95_MS);
    expect(peakHeapDelta).toBeLessThanOrEqual(BUDGET_BYTES);
  });
});
