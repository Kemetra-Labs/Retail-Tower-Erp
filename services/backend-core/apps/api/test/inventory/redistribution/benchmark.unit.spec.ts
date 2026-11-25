/**
 * RT-1598 AC5 — performance benchmark at the P-6 caps (50 stores, 20,000 rows), against the D-3 budget:
 * p95 compute <= 5 s and <= 256 MB per run.
 *
 * Memory is a hard bound, not a sampled delta: the module runs in a separate Node process started with
 * `--max-old-space-size=232 --max-semi-space-size=8`, a V8 heap limit of exactly 256 MB (asserted from inside the
 * child). Needing more heap would crash the child with an out-of-memory error and fail this spec.
 * A `worker_threads` `resourceLimits` cap is NOT used: a process-wide `--max-old-space-size` (CircleCI sets
 * `NODE_OPTIONS=--max-old-space-size=4096`) overrides it, and the worker silently got a 4 GB heap (RT-1598).
 * The child gets `NODE_OPTIONS` cleared for the same reason.
 *
 * The child cannot load TypeScript, so the module and the fixtures are transpiled (TypeScript's own
 * `transpileModule`, no type check) into a temporary directory first. Seeded synthetic tenants only.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import * as ts from "typescript";

const API = resolve(__dirname, "../../..");
const MODULE_DIR = join(API, "src/inventory/redistribution");
const FIXTURES = join(API, "test/inventory/redistribution/fixtures.ts");

const BUDGET_P95_MS = 5000;
const BUDGET_HEAP_BYTES = 256 * 1048576;
/** Old generation 232 MB + young generation (3 x 8 MB semi-space) = a 256 MB V8 heap limit. */
const HEAP_FLAGS = ["--max-old-space-size=232", "--max-semi-space-size=8"];
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

const CHILD = `
const { proposeRedistribution } = require(process.argv[2]);
const { mulberry32, syntheticProblem } = require(process.argv[3]);
const { runs: RUNS, seeds } = JSON.parse(process.argv[4]);
const tenants = seeds.map((seed) => syntheticProblem(mulberry32(seed), { stores: 50, products: 400, density: 1 }));
const runs = [];
let heapUsedMax = 0;
for (let i = 0; i < RUNS; i++) {
  const tenant = tenants[i % tenants.length];
  const t0 = process.hrtime.bigint();
  const r = proposeRedistribution(tenant);
  runs.push({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status: r.status, rows: tenant.rows.length, lines: r.moves.length });
  heapUsedMax = Math.max(heapUsedMax, process.memoryUsage().heapUsed);
}
process.stdout.write(JSON.stringify({ runs, heapUsedMax, heapSizeLimit: require("node:v8").getHeapStatistics().heap_size_limit }));
`;

interface ChildReport {
  readonly runs: ReadonlyArray<{ ms: number; status: string; rows: number; lines: number }>;
  readonly heapUsedMax: number;
  readonly heapSizeLimit: number;
}

function runCapped(out: string): ChildReport {
  const script = join(out, "bench-child.js");
  writeFileSync(script, CHILD);
  const result = spawnSync(
    process.execPath,
    [
      ...HEAP_FLAGS,
      script,
      join(out, "src/inventory/redistribution/propose.js"),
      join(out, "test/inventory/redistribution/fixtures.js"),
      JSON.stringify({ runs: RUNS, seeds: SEEDS }),
    ],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: 100_000, maxBuffer: 1 << 20 },
  );
  if (result.status !== 0) {
    throw new Error(`benchmark child failed (status ${String(result.status)}, signal ${String(result.signal)}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as ChildReport;
}

const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

describe("redistribution benchmark at the caps (D-3 budget)", () => {
  it("computes 50 stores x 400 products (20,000 rows) within p95 5 s, in a process capped at a 256 MB heap", () => {
    const out = mkdtempSync(join(tmpdir(), "rt1598-bench-"));
    try {
      transpileInto(out);
      const report = runCapped(out);
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
      // The cap the child really ran under (read inside it), so every run above fitted a 256 MB heap.
      expect(report.heapSizeLimit).toBeLessThanOrEqual(BUDGET_HEAP_BYTES);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
