#!/usr/bin/env node
// RT-1199: code-health ratchet for services/backend-core.
//
// Measures dead code (knip, knip.json), duplication (jscpd, .jscpd.json) and size/complexity
// warnings (ESLint, rules in tools/code-health/rules.cjs), then compares them with the committed
// baseline tools/code-health/baseline.json. It fails (exit 1) when any count grows, and passes
// with a hint when a count shrinks so the PR that cleans up lowers the baseline (--update).
// --update refuses when any count grew, so a rise needs a hand edit of the baseline in the PR,
// with owner approval.
// RT-1295: it also fails when a file already over `max-lines` gains lines, or a new file goes
// over the limit (baseline `oversizedFiles`), so an oversized file cannot keep growing while
// the eslintMaxLines count stays the same.
//
// Usage: node tools/code-health/check.mjs [--update]   (from services/backend-core)
// Exit codes: 0 pass, 1 a count grew past the baseline, 2 a tool or the baseline failed.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BaselineError,
  METRICS,
  compare,
  compareOversizedFiles,
  maxLinesActual,
  parseBaseline,
} from "./compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const baselineFile = path.join(here, "baseline.json");
const require = createRequire(import.meta.url);
const { SIZE_RULE_FILES, SIZE_RULE_IGNORES, SIZE_RULES } = require("./rules.cjs");

class ToolError extends Error {}

/** The JS entry point of a locally installed package's binary (no shell, same on every OS). */
function binPath(pkg, bin) {
  // Read the manifest by path: some packages (knip) do not export ./package.json.
  const manifestPath = path.join(root, "node_modules", pkg, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new ToolError(`${pkg} is not installed (run pnpm install): ${err.message}`);
  }
  const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
  if (typeof relative !== "string") throw new ToolError(`${pkg} has no "${bin}" binary`);
  return path.join(path.dirname(manifestPath), relative);
}

function run(pkg, bin, args) {
  const result = spawnSync(process.execPath, [binPath(pkg, bin), ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new ToolError(`${bin} failed to start: ${result.error.message}`);
  return result;
}

function expectStatus(name, result, allowed) {
  if (!allowed.includes(result.status)) {
    throw new ToolError(`${name} exited ${String(result.status)}: ${result.stderr.slice(0, 500)}`);
  }
}

function parseToolJson(name, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError(`${name} did not print JSON: ${text.slice(0, 300)}`);
  }
}

function countEntries(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function measureKnip() {
  const result = run("knip", "knip", ["--reporter", "json", "--no-progress"]);
  // knip exits 1 when it finds issues; anything else non-zero is a tool failure.
  expectStatus("knip", result, [0, 1]);
  const report = parseToolJson("knip", result.stdout);
  const sum = (key) => report.issues.reduce((total, issue) => total + countEntries(issue[key]), 0);
  return {
    knipUnusedFiles: sum("files"),
    knipUnusedExports: sum("exports") + sum("nsExports") + sum("enumMembers"),
    knipUnusedTypes: sum("types") + sum("nsTypes"),
    knipUnusedDependencies: sum("dependencies") + sum("devDependencies"),
    knipUnlistedDependencies: sum("unlisted"),
    knipDuplicateExports: sum("duplicates"),
  };
}

function measureJscpd() {
  const out = mkdtempSync(path.join(tmpdir(), "bc-jscpd-"));
  try {
    const result = run("jscpd", "jscpd", ["--config", ".jscpd.json", "--output", out]);
    expectStatus("jscpd", result, [0]);
    const report = parseToolJson("jscpd", readFileSync(path.join(out, "jscpd-report.json"), "utf8"));
    return {
      jscpdClones: report.statistics.total.clones,
      jscpdDuplicatedLines: report.statistics.total.duplicatedLines,
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** A path relative to services/backend-core, with forward slashes on every OS. */
function relativeToRoot(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function countRuleMessages(results) {
  const counts = { complexity: 0, "max-lines-per-function": 0, "max-lines": 0 };
  const oversizedFiles = {};
  const messages = results.flatMap((file) => file.messages.map((message) => ({ file, message })));
  for (const { file, message } of messages) {
    if (message.fatal) throw new ToolError(`eslint could not parse ${file.filePath}`);
    if (Object.hasOwn(counts, message.ruleId ?? "")) counts[message.ruleId] += 1;
    if (message.ruleId === "max-lines") {
      const lines = maxLinesActual(message.message);
      if (lines === null) {
        throw new ToolError(`unexpected max-lines message for ${file.filePath}: ${message.message}`);
      }
      oversizedFiles[relativeToRoot(file.filePath)] = lines;
    }
  }
  return { counts, oversizedFiles };
}

async function measureEslint() {
  // Only the size/complexity rules (ESLint 8 API, no .eslintrc): fast, and independent of the
  // `pnpm lint:eslint` step that already runs every other rule. Other rule ids never count.
  const { ESLint } = require("eslint");
  const eslint = new ESLint({
    cwd: root,
    useEslintrc: false,
    overrideConfig: {
      parser: "@typescript-eslint/parser",
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      ignorePatterns: SIZE_RULE_IGNORES,
      rules: SIZE_RULES,
    },
  });
  const { counts, oversizedFiles } = countRuleMessages(await eslint.lintFiles(SIZE_RULE_FILES));
  return {
    eslintComplexity: counts.complexity,
    eslintMaxLinesPerFunction: counts["max-lines-per-function"],
    eslintMaxLines: counts["max-lines"],
    oversizedFiles,
  };
}

function readBaseline() {
  let text;
  try {
    text = readFileSync(baselineFile, "utf8");
  } catch (err) {
    throw new BaselineError(`cannot read ${baselineFile}: ${err.message}`);
  }
  try {
    return parseBaseline(JSON.parse(text));
  } catch (err) {
    if (err instanceof BaselineError) throw err;
    throw new BaselineError(`${baselineFile} is not valid JSON: ${err.message}`);
  }
}

function writeBaseline(current) {
  const body = {
    $comment: "RT-1199 code-health ratchet. Lower is better; counts may only go down.",
  };
  for (const metric of METRICS) body[metric] = current[metric];
  body.oversizedFiles = Object.fromEntries(
    Object.entries(current.oversizedFiles).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  writeFileSync(baselineFile, `${JSON.stringify(body, null, 2)}\n`);
}

function reportShrank(shrank, files) {
  for (const { metric, current: now, baseline } of shrank) {
    console.log(`code-health: hint: ${metric} dropped to ${now} (baseline ${baseline}).`);
  }
  for (const { file, current: now, baseline } of files.shrank) {
    const state = now === 0 ? "is no longer over max-lines" : `dropped to ${now} lines`;
    console.log(`code-health: hint: ${file} ${state} (baseline ${baseline}).`);
  }
  if (shrank.length > 0 || files.shrank.length > 0) {
    console.log("code-health: hint: run `pnpm code-health:update` in this PR.");
  }
}

function reportGrew(grew, files, ok) {
  for (const { metric, current: now, baseline } of grew) {
    console.error(
      `code-health: FAIL ${metric} is ${now}, baseline is ${baseline} (+${now - baseline}).`,
    );
  }
  for (const { file, current: now, baseline } of files.grew) {
    console.error(
      `code-health: FAIL ${file} is over max-lines and grew to ${now} lines, baseline is ` +
        `${baseline} (+${now - baseline}). Move code out instead of adding to it.`,
    );
  }
  for (const { file, current: now } of files.added) {
    console.error(`code-health: FAIL ${file} went over max-lines (${now} lines).`);
  }
  if (ok) {
    console.log("code-health: OK, no count grew.");
    return 0;
  }
  console.error(
    "code-health: remove the new unused code, duplication or oversized function. If the " +
      "baseline must rise, edit tools/code-health/baseline.json by hand and explain why in the " +
      "PR (owner approval required); --update never raises it.",
  );
  return 1;
}

async function measureAll() {
  return { ...measureKnip(), ...measureJscpd(), ...(await measureEslint()) };
}

async function main(args) {
  const current = await measureAll();
  const { oversizedFiles, ...counts } = current;
  console.table(counts);
  const baseline = readBaseline();
  const { grew, shrank, ok: countsOk } = compare(counts, baseline);
  const files = compareOversizedFiles(oversizedFiles, baseline.oversizedFiles);
  const ok = countsOk && files.ok;
  // --update only lowers the baseline: a count or file that grew fails here as in a normal run,
  // so a drop in one metric or file can never carry a rise in another into the baseline.
  if (args.includes("--update") && ok) {
    writeBaseline(current);
    console.log("code-health: baseline written.");
    return 0;
  }
  if (!args.includes("--update")) reportShrank(shrank, files);
  return reportGrew(grew, files, ok);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof ToolError) && !(err instanceof BaselineError)) throw err;
  console.error(`code-health: ERROR ${err.message}`);
  process.exitCode = 2;
}
