// RT-1200: code-health ratchet for apps/admin-console.
//
// Measures dead code (knip, knip.json), duplication (jscpd, .jscpd.json) and Biome
// noExcessiveCognitiveComplexity warnings (biome.json), then compares them with the committed
// baseline scripts/code-health/baseline.json. It fails (exit 1) when any count grows, and passes
// with a hint when a count shrinks so the PR that cleans up lowers the baseline (--update).
// --update refuses when any count grew, so a rise needs a hand edit of the baseline in the PR,
// with owner approval.
//
// Usage: pnpm code-health [--update]   (node strips the types; no build step)
// Exit codes: 0 pass, 1 a count grew past the baseline, 2 a tool or the baseline failed.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BaselineError,
  type Change,
  type Counts,
  METRICS,
  compare,
  parseBaseline,
} from "./compare.ts";

const root = path.resolve(import.meta.dirname, "..", "..");
const baselineFile = path.join(import.meta.dirname, "baseline.json");
const COMPLEXITY_CATEGORY = "lint/complexity/noExcessiveCognitiveComplexity";

class ToolError extends Error {}

/** A locally installed CLI: its package, its binary name and the exit codes that mean "ran". */
interface Tool {
  readonly pkg: string;
  readonly bin: string;
  readonly okStatus: readonly number[];
}

// knip and biome exit 1 when they find issues; the counts still work, `pnpm lint` reports errors.
const KNIP: Tool = { pkg: "knip", bin: "knip", okStatus: [0, 1] };
const JSCPD: Tool = { pkg: "jscpd", bin: "jscpd", okStatus: [0] };
const BIOME: Tool = { pkg: "@biomejs/biome", bin: "biome", okStatus: [0, 1] };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The JS entry point of a locally installed package's binary (no shell, same on every OS). */
function binPath(tool: Tool): string {
  // Read the manifest by path: some packages (knip) do not export ./package.json.
  const manifestPath = path.join(root, "node_modules", tool.pkg, "package.json");
  let manifest: { bin?: string | Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new ToolError(`${tool.pkg} is not installed (run pnpm install): ${messageOf(err)}`);
  }
  const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[tool.bin];
  if (typeof relative !== "string") throw new ToolError(`${tool.pkg} has no "${tool.bin}" binary`);
  return path.join(path.dirname(manifestPath), relative);
}

/** Runs the tool and fails on a start error or an exit code outside tool.okStatus. */
function run(tool: Tool, args: readonly string[]): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, [binPath(tool), ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new ToolError(`${tool.bin} failed to start: ${result.error.message}`);
  if (result.status === null || !tool.okStatus.includes(result.status)) {
    const detail = result.stderr.slice(0, 500);
    throw new ToolError(`${tool.bin} exited ${String(result.status)}: ${detail}`);
  }
  return result;
}

function parseToolJson<T>(tool: Tool, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError(`${tool.bin} did not print JSON: ${text.slice(0, 300)}`);
  }
}

function countEntries(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

type KnipReport = { issues: Record<string, unknown>[] };

function measureKnip(): Partial<Counts> {
  const result = run(KNIP, ["--reporter", "json", "--no-progress"]);
  const report = parseToolJson<KnipReport>(KNIP, result.stdout);
  // Total entries across every issue, for the listed knip issue types.
  const sum = (keys: readonly string[]) =>
    report.issues.reduce(
      (total, issue) => total + keys.reduce((n, key) => n + countEntries(issue[key]), 0),
      0,
    );
  return {
    knipUnusedFiles: sum(["files"]),
    knipUnusedExports: sum(["exports", "nsExports", "enumMembers"]),
    knipUnusedTypes: sum(["types", "nsTypes"]),
    knipUnusedDependencies: sum(["dependencies", "devDependencies"]),
    knipUnlistedDependencies: sum(["unlisted"]),
    knipDuplicateExports: sum(["duplicates"]),
  };
}

type JscpdReport = { statistics: { total: { clones: number; duplicatedLines: number } } };

function measureJscpd(): Partial<Counts> {
  const out = mkdtempSync(path.join(tmpdir(), "admin-jscpd-"));
  try {
    run(JSCPD, ["--config", ".jscpd.json", "--output", out]);
    const text = readFileSync(path.join(out, "jscpd-report.json"), "utf8");
    const { total } = parseToolJson<JscpdReport>(JSCPD, text).statistics;
    return { jscpdClones: total.clones, jscpdDuplicatedLines: total.duplicatedLines };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

type BiomeReport = {
  summary: { diagnosticsNotPrinted: number };
  diagnostics: { category?: string }[];
};

function measureBiome(): Partial<Counts> {
  // The same files and rules as `pnpm lint`; only the cognitive-complexity warnings count.
  const result = run(BIOME, ["lint", "--reporter=json", "--max-diagnostics=10000", "."]);
  const report = parseToolJson<BiomeReport>(BIOME, result.stdout);
  if (report.summary.diagnosticsNotPrinted > 0) {
    throw new ToolError(`biome left ${report.summary.diagnosticsNotPrinted} diagnostics unprinted`);
  }
  const hits = report.diagnostics.filter((d) => d.category === COMPLEXITY_CATEGORY);
  return { biomeCognitiveComplexity: hits.length };
}

function readBaseline(): Counts {
  let text: string;
  try {
    text = readFileSync(baselineFile, "utf8");
  } catch (err) {
    throw new BaselineError(`cannot read ${baselineFile}: ${messageOf(err)}`);
  }
  try {
    return parseBaseline(JSON.parse(text));
  } catch (err) {
    if (err instanceof BaselineError) throw err;
    throw new BaselineError(`${baselineFile} is not valid JSON: ${messageOf(err)}`);
  }
}

function writeBaseline(current: Counts): void {
  const body: Record<string, string | number> = {
    $comment: "RT-1200 code-health ratchet. Lower is better; counts may only go down.",
  };
  for (const metric of METRICS) body[metric] = current[metric];
  writeFileSync(baselineFile, `${JSON.stringify(body, null, 2)}\n`);
}

function reportShrank(shrank: Change[]): void {
  for (const { metric, current, baseline } of shrank) {
    console.log(`code-health: hint: ${metric} dropped to ${current} (baseline ${baseline}).`);
  }
  if (shrank.length > 0) {
    console.log("code-health: hint: run `pnpm code-health:update` in this PR.");
  }
}

function reportGrew({ grew, ok }: { grew: Change[]; ok: boolean }): number {
  for (const { metric, current, baseline } of grew) {
    console.error(
      `code-health: FAIL ${metric} is ${current}, baseline is ${baseline} (+${current - baseline}).`,
    );
  }
  if (ok) {
    console.log("code-health: OK, no count grew.");
    return 0;
  }
  console.error(
    "code-health: remove the new unused code, duplication or complex function. If the baseline " +
      "must rise, edit scripts/code-health/baseline.json by hand and explain why in the PR " +
      "(owner approval required); --update never raises it.",
  );
  return 1;
}

function main(args: readonly string[]): number {
  const current = { ...measureKnip(), ...measureJscpd(), ...measureBiome() };
  console.table(current);
  const result = compare(current, readBaseline());
  const update = args.includes("--update");
  // --update only lowers the baseline: a count that grew fails here as in a normal run, so a drop
  // in one metric can never carry a rise in another into the baseline.
  if (update && result.ok) {
    writeBaseline(current as Counts);
    console.log("code-health: baseline written.");
    return 0;
  }
  if (!update) reportShrank(result.shrank);
  return reportGrew(result);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof ToolError) && !(err instanceof BaselineError)) throw err;
  console.error(`code-health: ERROR ${err.message}`);
  process.exitCode = 2;
}
