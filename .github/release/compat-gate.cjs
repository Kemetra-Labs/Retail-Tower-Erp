#!/usr/bin/env node
// RT-871: the Backend-Core release guard for the root release workflow
// (.github/workflows/release-backend-core.yml). MR-3: a Backend-Core release requires
// `contracts-compat` for the release SHA. Ported from Kemetra/Backend-Core
// deploy/release-compat-gate.cjs (RT-863, merged as fd95ef8), owner decision MR-3
// (RT-863 comment 13811), option (b) with automatic tightening:
//
//   - The release SHA's own compat check run must be green, together with the other required
//     checks. The product reads them in release-images.yml with jq; here the same rule
//     (latest github-actions run per name must be `success`) is judged in judgeChecks so the
//     spec can cover it. Missing, failed, cancelled, skipped, timed out: all refuse.
//   - The fleet baseline in the release commit's contracts-compat/pos-supported.yaml must be
//     fresh NOW (FAIL_STALE_FLEET), and not dated in the future.
//   - Until every supported snapshot has a `recorded` replay fixture, envelope/replay is
//     NOT_PROVEN: recorded in the evidence, never blocking. Once every supported snapshot has
//     one, the mode is `release` with no code change.
//
// Differences from the product module, all forced by the monorepo:
//   - paths: the release commit's Backend-Core tree is services/backend-core/ (--source), and
//     contracts-compat's parser comes from --lib (the workflow's own checkout), not __dirname.
//   - the required check names are the root workflow's (bc/fast, ...), passed with --required.
//   - Shadow's Backend-Core import (tools/history/frozen.tsv) predates RT-713, so today both
//     the compat check run and contracts-compat/ are absent and every release SHA is refused.
//     That is the intended fail-closed state until the MR-8 re-import and a root compat job.
//
// Reads only files and a check-run list; makes no network call and fails closed: anything it
// cannot read or parse is a refusal. Parsing is never re-implemented: contracts-compat's own
// parseYamlSubset + validateStructure + snapshotId + PROVENANCE run in a child node process.
//
// CLI:
//   node .github/release/compat-gate.cjs --checks FILE --required JSON --source DIR --lib DIR [--now ISO]
// --checks: JSON array of {name, conclusion, slug, started_at} for the release SHA.
// Prints the decision; exit 0 = pass, 1 = refused, 2 = usage error.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const COMPAT_CHECK = "bc/contracts-compat";
const TRUSTED_SLUG = "github-actions";
const MAX_CLOCK_SKEW_DAYS = 1 / 24;
const MATRIX = path.join("contracts-compat", "pos-supported.yaml");
const REPLAY = path.join("contracts-compat", "replay");
const MAX_FILE_BYTES = 1024 * 1024;

/** A regular file under the size cap, never through a symlink; null otherwise. */
function readRegular(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= MAX_FILE_BYTES ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

function isRealDir(dir) {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The latest run per required name, from the trusted app only, must be `success`.
 * @returns {{ problems: string[], notes: string[] }}
 */
function judgeChecks(runs, required) {
  const problems = [];
  const notes = [];
  if (!Array.isArray(runs)) return { problems: ["check runs for the release SHA are unreadable"], notes };
  if (!Array.isArray(required) || required.length === 0) return { problems: ["no required checks configured"], notes };
  if (!required.includes(COMPAT_CHECK)) problems.push(`required checks do not include ${COMPAT_CHECK} (MR-3)`);
  for (const name of required) {
    const latest = runs
      .filter((r) => r && r.name === name && r.slug === TRUSTED_SLUG)
      .sort((a, b) => String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")))
      .at(-1);
    const result = latest ? (latest.conclusion ?? "pending") : "missing";
    notes.push(`check '${name}': ${result}`);
    if (result !== "success") problems.push(`required check '${name}' is '${result}' on the release SHA`);
  }
  return { problems, notes };
}

/** replay/<dir>/*.yaml texts by directory name; a dir maps to null when anything in it is unreadable. */
function readFixtures(sourceDir) {
  const root = path.join(sourceDir, REPLAY);
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    if (!isRealDir(dir)) {
      out[id] = null;
      continue;
    }
    const texts = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().map((f) => readRegular(path.join(dir, f)));
    out[id] = texts.includes(null) ? null : texts;
  }
  return out;
}

// Runs in a child node process (ESM). Input on stdin: { matrix, fixtures }; output on stdout.
const PARSE_SCRIPT = `
import { readFileSync } from "node:fs";
const [ev, ys, rp] = await Promise.all([import(process.env.COMPAT_EVALUATE), import(process.env.COMPAT_YAML), import(process.env.COMPAT_REPLAY)]);
const input = JSON.parse(readFileSync(0, "utf8"));
const out = { freshnessDays: ev.FRESHNESS_DAYS, provenance: {} };
try {
  const m = ys.parseYamlSubset(input.matrix);
  const problems = ev.validateStructure(m);
  if (problems.length > 0) out.error = "invalid matrix: " + problems.join("; ");
  else Object.assign(out, { capturedAt: m.fleet_baseline.captured_at, ids: m.supported.map(ev.snapshotId) });
} catch (e) {
  out.error = e.message;
}
for (const [id, texts] of Object.entries(input.fixtures)) {
  try {
    const values = texts === null ? null : texts.map((t) => ys.parseYamlSubset(t).provenance);
    // a provenance contracts-compat does not know is unreadable, never "not recorded"
    out.provenance[id] = values && values.every((p) => rp.PROVENANCE.includes(p)) ? values : null;
  } catch {
    out.provenance[id] = null;
  }
}
process.stdout.write(JSON.stringify(out));
`;

/** Parse with contracts-compat's own code. Throws when it cannot run or answer. */
function parseWithCompatLib(libDir, matrix, fixtures) {
  for (const f of ["evaluate.mjs", "yaml-subset.mjs", "replay.mjs"]) {
    if (readRegular(path.join(libDir, f)) === null) throw new Error(`contracts-compat parser ${path.join(libDir, f)} is missing`);
  }
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", PARSE_SCRIPT], {
    input: JSON.stringify({ matrix, fixtures }),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      COMPAT_EVALUATE: pathToFileURL(path.resolve(libDir, "evaluate.mjs")).href,
      COMPAT_YAML: pathToFileURL(path.resolve(libDir, "yaml-subset.mjs")).href,
      COMPAT_REPLAY: pathToFileURL(path.resolve(libDir, "replay.mjs")).href,
    },
  });
  if (res.status !== 0) throw new Error(`contracts-compat parser did not run (${(res.stderr || String(res.error ?? "")).trim().split("\n")[0]})`);
  const out = JSON.parse(res.stdout);
  if (!Number.isFinite(out.freshnessDays)) throw new Error("contracts-compat parser returned no FRESHNESS_DAYS");
  return out;
}

function freshnessProblem(stamp, now, freshnessDays) {
  const ageDays = (now.getTime() - Date.parse(stamp)) / 86_400_000;
  if (Number.isNaN(ageDays)) return `fleet_baseline.captured_at is not a date (${stamp})`;
  if (ageDays < -MAX_CLOCK_SKEW_DAYS) return `fleet_baseline.captured_at is in the future (${stamp})`;
  if (ageDays <= freshnessDays) return null;
  return `FAIL_STALE_FLEET: fleet_baseline.captured_at is ${ageDays.toFixed(1)} days old (limit ${freshnessDays}); refresh the fleet baseline on RT-713 before releasing`;
}

/**
 * Judge the compat files of the release commit.
 * @returns { mode: 'release'|'pr+fleet'|null, problems: string[], notes: string[] }
 */
function evaluateCompat(sourceDir, libDir, now = new Date()) {
  const refuse = (why) => ({ mode: null, problems: [`POS compat gate (${COMPAT_CHECK}): ${why}`], notes: [] });
  for (const dir of ["contracts-compat", REPLAY]) {
    if (fs.existsSync(path.join(sourceDir, dir)) && !isRealDir(path.join(sourceDir, dir))) {
      return refuse(`${dir} in the release commit is not a real directory`);
    }
  }
  const text = readRegular(path.join(sourceDir, MATRIX));
  if (text === null) return refuse(`${MATRIX} is missing or unreadable in the release commit`);
  let parsed;
  try {
    parsed = parseWithCompatLib(libDir, text, readFixtures(sourceDir));
  } catch (err) {
    return refuse(err.message);
  }
  if (parsed.error) return refuse(`cannot read ${MATRIX}: ${parsed.error}`);
  const { capturedAt: stamp, ids } = parsed;
  const problems = [];
  const stale = freshnessProblem(stamp, now, parsed.freshnessDays);
  if (stale) problems.push(`POS compat gate: ${stale}`);
  const unrecorded = [];
  for (const id of ids) {
    const provenance = Object.hasOwn(parsed.provenance, id) ? parsed.provenance[id] : [];
    if (provenance === null) return refuse(`replay fixtures for ${id} are unreadable`);
    if (!provenance.includes("recorded")) unrecorded.push(id);
  }
  // Release mode only once every supported snapshot (at least one) has a recorded fixture.
  const mode = ids.length > 0 && unrecorded.length === 0 ? "release" : "pr+fleet";
  const notes = [];
  if (mode === "release") {
    notes.push(`POS compat: --mode release semantics (a recorded replay fixture for each of ${ids.length} supported snapshot(s))`);
  } else {
    const which = ids.length === 0 ? "no supported snapshot" : `no recorded replay fixture for ${unrecorded.join(", ")}`;
    notes.push(
      `POS compat: PR-mode result + fresh fleet (RT-863 option b); release-mode envelope/replay NOT_PROVEN (${which}); not blocking until every supported snapshot has a recorded fixture`,
    );
  }
  notes.push(`POS compat: fleet baseline captured ${stamp}`);
  return { mode, problems, notes };
}

/** Both halves: the check runs and the release commit's compat files. */
function evaluateGuard({ runs, required, sourceDir, libDir, now = new Date() }) {
  const checks = judgeChecks(runs, required);
  const compat = evaluateCompat(sourceDir, libDir, now);
  const problems = [...checks.problems, ...compat.problems];
  return {
    verdict: problems.length ? "REFUSED" : "PASS",
    mode: compat.mode,
    problems,
    notes: [...checks.notes, ...compat.notes],
  };
}

function main(argv) {
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const [checksFile, requiredJson, source, lib] = ["--checks", "--required", "--source", "--lib"].map(get);
  const now = get("--now") ? new Date(get("--now")) : new Date();
  if (!checksFile || !requiredJson || !source || !lib || Number.isNaN(now.getTime()) || argv.length % 2 !== 0) {
    console.error("usage: compat-gate.cjs --checks FILE --required JSON --source DIR --lib DIR [--now ISO]");
    return 2;
  }
  let runs = null;
  let required = null;
  try {
    runs = JSON.parse(readRegular(checksFile) ?? "null");
  } catch {
    runs = null;
  }
  try {
    required = JSON.parse(requiredJson);
  } catch {
    required = null;
  }
  const result = evaluateGuard({ runs, required, sourceDir: source, libDir: lib, now });
  result.notes.forEach((n) => console.log(n));
  result.problems.forEach((p) => console.log(`::error::${p}`));
  console.log(`POS compat gate: ${result.verdict} (mode ${result.mode ?? "unknown"})`);
  return result.problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { COMPAT_CHECK, MAX_CLOCK_SKEW_DAYS, judgeChecks, evaluateCompat, evaluateGuard, main };
