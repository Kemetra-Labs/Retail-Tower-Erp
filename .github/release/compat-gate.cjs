#!/usr/bin/env node
// RT-871: the Backend-Core release guard for the root release workflow
// (.github/workflows/release-backend-core.yml). MR-3: a Backend-Core release requires
// `contracts-compat` for the release SHA. Ported from Kemetra/Backend-Core
// deploy/release-compat-gate.cjs (RT-863, merged as fd95ef8), owner decision MR-3
// (RT-863 comment 13811), option (b) with automatic tightening:
//
//   - RT-1471 Phase 2 (owner decision, option C: no dispatch). The guard stays read-only and
//     starts no workflow. Each required run must also report head_sha == the release SHA
//     (--sha, 40 lowercase hex); a run for another commit, or with no head_sha, refuses. When a
//     required check is missing or still running, the refusal names the one exact-SHA
//     verification that exists (the main-pinned workflow_dispatch of RT-1471 Phase 1) as the way
//     to prove the SHA before re-running the release; it never runs it.
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
//   - the compat check run is the root job bc/contracts-compat (backend-core.yml, RT-863), and
//     the matrix references snapshots by commits of this repository (re-keyed through
//     tools/history/crosswalk/ after the RT-715 cutover).
//
// Reads only files and a check-run list; makes no network call and fails closed: anything it
// cannot read or parse is a refusal. Parsing is never re-implemented: contracts-compat's own
// parseYamlSubset + validateStructure + snapshotId + PROVENANCE run in a child node process.
//
// CLI:
//   node .github/release/compat-gate.cjs --checks FILE --required JSON --source DIR --lib DIR --sha SHA [--now ISO]
// --checks: JSON array of {name, conclusion, slug, started_at, head_sha} for the release SHA.
// --sha: the 40-character release SHA; every required run must report it as head_sha.
// Prints the decision; exit 0 = pass, 1 = refused, 2 = usage error.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const COMPAT_CHECK = "bc/contracts-compat";
const TRUSTED_SLUG = "github-actions";
const MAX_CLOCK_SKEW_DAYS = 1 / 24;
const SHA_RE = /^[0-9a-f]{40}$/;
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
 * The latest run per required name, from the trusted app only, must be `success`, and must belong
 * to the release SHA: a run that reports another head_sha (or none) is a refusal, never a pass and
 * never silently ignored.
 * @returns {{ problems: string[], notes: string[], needsProof: boolean }} needsProof: some required
 *   check is missing or still running, so a full exact-SHA run could settle it (a red one could not).
 */
function judgeChecks(runs, required, sha) {
  const problems = [];
  const notes = [];
  let sawMissing = false; // a required check is missing or still running
  let blocked = false; // something a dispatch cannot clear: a red check or a foreign head SHA
  if (typeof sha !== "string" || !SHA_RE.test(sha)) problems.push("release SHA is not a 40-character lowercase hex SHA");
  if (!Array.isArray(runs)) return { problems: [...problems, "check runs for the release SHA are unreadable"], notes, needsProof: false };
  if (!Array.isArray(required) || required.length === 0) return { problems: [...problems, "no required checks configured"], notes, needsProof: false };
  if (!required.includes(COMPAT_CHECK)) problems.push(`required checks do not include ${COMPAT_CHECK} (MR-3)`);
  const valid = runs.filter((r) => r && typeof r === "object");
  for (const name of required) {
    const trusted = valid.filter((r) => r.name === name && r.slug === TRUSTED_SLUG);
    const foreign = trusted.filter((r) => r.head_sha !== sha);
    for (const r of foreign) {
      problems.push(`check '${name}' reports head SHA '${r.head_sha ?? "none"}', not the release SHA ${sha}`);
      blocked = true;
    }
    // The newest run decides. A run with no started_at is the newest (a queued re-run), and every run
    // that ties for the newest time must be green: the answer never depends on the API's array order.
    const own = trusted.filter((r) => r.head_sha === sha);
    const when = (r) => (typeof r.started_at === "string" && r.started_at !== "" ? r.started_at : "\uffff");
    const newest = own.reduce((max, r) => (when(r) > max ? when(r) : max), "");
    const deciding = own.filter((r) => when(r) === newest);
    const bad = deciding.find((r) => r.conclusion !== "success");
    const result = own.length === 0 ? "missing" : bad ? (bad.conclusion ?? "pending") : "success";
    notes.push(`check '${name}': ${result}`);
    if (result !== "success") problems.push(`required check '${name}' is '${result}' on the release SHA`);
    if (result === "missing" || result === "pending") sawMissing = true;
    else if (result !== "success") blocked = true;
  }
  return { problems, notes, needsProof: sawMissing && !blocked };
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
function evaluateGuard({ runs, sha, required, sourceDir, libDir, now = new Date() }) {
  const checks = judgeChecks(runs, required, sha);
  const compat = evaluateCompat(sourceDir, libDir, now);
  const problems = [...checks.problems, ...compat.problems];
  const notes = [...checks.notes, ...compat.notes];
  if (checks.needsProof && SHA_RE.test(sha)) notes.push(proofHint(sha));
  return { verdict: problems.length ? "REFUSED" : "PASS", mode: compat.mode, problems, notes };
}

/** RT-1471 Phase 2 (option C): the only exact-SHA proof there is. The guard prints it and runs nothing. */
function proofHint(sha) {
  return (
    `To prove ${sha}: while it is still the tip of main, run \`gh workflow run backend-core.yml --ref main -f expected_sha=${sha}\` ` +
    "(RT-1471 Phase 1, owner-authorized), wait for it to pass, then re-run this release. If main has moved, cut the release " +
    "from a commit that a nightly or a manual full run has already proven. The guard dispatches nothing."
  );
}

function main(argv) {
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const [checksFile, requiredJson, source, lib, sha] = ["--checks", "--required", "--source", "--lib", "--sha"].map(get);
  const now = get("--now") ? new Date(get("--now")) : new Date();
  if (!checksFile || !requiredJson || !source || !lib || !sha || Number.isNaN(now.getTime()) || argv.length % 2 !== 0) {
    console.error("usage: compat-gate.cjs --checks FILE --required JSON --source DIR --lib DIR --sha SHA [--now ISO]");
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
  const result = evaluateGuard({ runs, sha, required, sourceDir: source, libDir: lib, now });
  result.notes.forEach((n) => console.log(n));
  result.problems.forEach((p) => console.log(`::error::${p}`));
  console.log(`POS compat gate: ${result.verdict} (mode ${result.mode ?? "unknown"})`);
  return result.problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SHA_RE, proofHint, COMPAT_CHECK, MAX_CLOCK_SKEW_DAYS, judgeChecks, evaluateCompat, evaluateGuard, main };
