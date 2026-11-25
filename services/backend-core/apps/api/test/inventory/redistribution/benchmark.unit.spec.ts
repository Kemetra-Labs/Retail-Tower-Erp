/**
 * RT-1598 AC5 — performance benchmark at the P-6 caps (50 stores, 20,000 rows), against the D-3 budget:
 * p95 compute <= 5 s and <= 256 MB per run.
 *
 * Memory is a hard bound, not a sampled delta: the module runs in a `worker_threads` Worker whose V8 heap is
 * capped at 256 MB (`resourceLimits`: 232 MB old + 16 MB young generation; V8 reports the resulting limit,
 * asserted <= 256 MB). Needing more would kill
 * the worker with ERR_WORKER_OUT_OF_MEMORY and fail this spec. That is also the off-thread fallback the plan
 * names (§4), so the measurement matches how compute would run if it ever left the request thread.
 *
 * The worker cannot load TypeScript, so the module and the fixtures are transpiled (TypeScript's own
 * `transpileModule`, no type check) into a temporary directory first. Seeded synthetic tenants only.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import * as ts from "typescript";

const API = resolve(__dirname, "../../..");
const MODULE_DIR = join(API, "src/inventory/redistribution");
const FIXTURES = join(API, "test/inventory/redistribution/fixtures.ts");

const BUDGET_P95_MS = 5000;
const HEAP_CAP = { maxOldGenerationSizeMb: 232, maxYoungGenerationSizeMb: 16 };
const RUNS = 15;
const SEEDS = [0x1598_b001, 0x1598_b002, 0x1598_b003];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Mirrors the apps/api layout under `out`, so the relative imports between the files still resolve. */
function transpileInto(out: string): void {
  for (const file of [...tsFiles(MODULE_DIR), FIXTURES]) {
    const js = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const target = join(out, relative(API, file)).replace(/\.ts$/, ".js");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, js);
  }
}

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { proposeRedistribution } = require(workerData.propose);
const { mulberry32, syntheticProblem } = require(workerData.fixtures);
const tenants = workerData.seeds.map((seed) =>
  syntheticProblem(mulberry32(seed), { stores: 50, products: 400, density: 1 }),
);
const runs = [];
let heapUsedMax = 0;
for (let i = 0; i < workerData.runs; i++) {
  const tenant = tenants[i % tenants.length];
  const t0 = process.hrtime.bigint();
  const r = proposeRedistribution(tenant);
  runs.push({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status: r.status, rows: tenant.rows.length, lines: r.moves.length });
  heapUsedMax = Math.max(heapUsedMax, process.memoryUsage().heapUsed);
}
parentPort.postMessage({ runs, heapUsedMax, heapSizeLimit: require("node:v8").getHeapStatistics().heap_size_limit });
`;

interface WorkerReport {
  readonly runs: ReadonlyArray<{ ms: number; status: string; rows: number; lines: number }>;
  readonly heapUsedMax: number;
  readonly heapSizeLimit: number;
}

function runCapped(out: string): Promise<WorkerReport> {
  return new Promise((done, fail) => {
    const worker = new Worker(WORKER, {
      eval: true,
      resourceLimits: HEAP_CAP,
      workerData: {
        propose: join(out, "src/inventory/redistribution/propose.js"),
        fixtures: join(out, "test/inventory/redistribution/fixtures.js"),
        seeds: SEEDS,
        runs: RUNS,
      },
    });
    worker.once("message", done);
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (code !== 0) fail(new Error(`benchmark worker exited with ${String(code)}`));
    });
  });
}

const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

describe("redistribution benchmark at the caps (D-3 budget)", () => {
  it("computes 50 stores x 400 products (20,000 rows) within p95 5 s, in a worker capped at a 256 MB heap", async () => {
    const out = mkdtempSync(join(tmpdir(), "rt1598-bench-"));
    try {
      transpileInto(out);
      const report = await runCapped(out);
      expect(report.runs).toHaveLength(RUNS);
      for (const r of report.runs) expect(r).toMatchObject({ status: "proposed", rows: 20_000 });
      const sorted = report.runs.map((r) => r.ms).sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
      // Evidence line for RT-1598 (D-3).
      console.log(
        `RT-1598 benchmark: runs=${RUNS} rows=20000 stores=50 p95=${p95.toFixed(1)}ms max=${sorted.at(-1)!.toFixed(1)}ms ` +
          `heapSizeLimit=${mb(report.heapSizeLimit)}MB heapUsedMax=${mb(report.heapUsedMax)}MB ` +
          `lines=${report.runs.map((r) => r.lines).join("/")}`,
      );
      expect(p95).toBeLessThanOrEqual(BUDGET_P95_MS);
      // The cap the worker really ran under (read inside it), so the run above fitted 256 MB of heap.
      expect(report.heapSizeLimit).toBeLessThanOrEqual(256 * 1048576);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
