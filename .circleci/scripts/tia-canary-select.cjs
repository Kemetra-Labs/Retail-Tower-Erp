#!/usr/bin/env node
// RT-1239: the owner-triggered impacted-only API Jest canary (remote_suite=api with
// api_tia_canary=true). A lab proof, never a gate: GitHub Actions `required` is unchanged.
//
// `plan` decides, before the run, whether the canary runs the IMPACTED specs or the FULL suite,
// and writes <out>/canary-plan.json plus <out>/canary-atoms.txt (the specs to pass to
// `jest --runTestsByPath`, relative to apps/api). IMPACTED needs every check below to pass;
// anything else, including an exception, is FULL with the reasons recorded:
//   - guard.json says TIA_ELIGIBLE and is pinned to this commit (CIRCLE_SHA1 == remote_expected_sha)
//   - list-tests exited 0 and every line it printed is a discovered spec; the selection is not empty
//   - every must-run spec the guard names (changelog fragments' spec) is discovered; it joins the set
//   - every spec file the branch adds or modifies is in the set
//   - the selection-only probe (`testsuite run --run-tests=none --analyze-tests=none`) found impact
//     data, analyzed nothing, and its counts agree: selected + skipped = discovered, the
//     per-reason counts add up to selected, and selected = the list-tests line count
// IMPACTED also always adds every TEXT READER: a spec that reads files or runs processes itself,
// or through a non-spec test module that does (helpers, transitively). Coverage maps a spec only
// to the modules it imports, so a spec that scans src/ or test/ as text (pos-isolation's import
// fence, route-marker enforcement, OpenAPI route scans) would otherwise be skipped when an
// unmapped file it reads changes. Found at run time from the specs' source, so the list cannot go
// stale; over-inclusion only runs more. One helper is exempt (EXEMPT_HELPERS): it reads only
// packages/db migrations, which the guard already forces FULL. Its reads are pinned by the test.
// A union that covers every spec is FULL (nothing would be skipped).
//
// `verify` runs after the tests, always: it compares the JUnit report with the plan and writes
// <out>/canary-report.json. It exits 1 when a planned spec has no result, or an IMPACTED run
// reports a spec it was not given, so a short run can never look green. Jest's own exit code
// stays the run step's.
//
// usage: tia-canary-select.cjs plan   --out <dir> [--api-root <dir>]
//        tia-canary-select.cjs verify --out <dir> --junit <dir|file> [--api-root <dir>]
//   inputs read from <out>: guard.json, selected.txt, list-tests.rc, discovered.txt, probe.log,
//   probe.rc, run-seconds (verify); env: CIRCLE_SHA1, EXPECTED_SHA
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { readGuard, parseJunit } = require("./tia-shadow-report.cjs");

const IMPACTED = "IMPACTED";
const FULL = "FULL";
const SHA_RE = /^[0-9a-f]{40}$/;
const API_PREFIX = "services/backend-core/apps/api/";
// A discovered atom is a plain relative spec path: no option-like, absolute, `..` or blank part.
const ATOM_RE = /^(?!-)(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/@+]+\.spec\.ts$/;

const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// File or process access in a test module: fs / child_process imports or calls, globbing.
const READ_RE = /['"](?:node:)?(?:fs|fs\/promises|child_process)['"]|\b(?:readFileSync|readdirSync|opendirSync|globSync|execSync|execFileSync|spawnSync)\b|fast-glob/;
// Test modules (relative to apps/api) whose file reads are known to be outside the TIA-eligible
// class. postgres-container reads only packages/db's drizzle migrations (any change there forces
// FULL); 208 specs import it, so counting it would make every DB spec a text reader.
const EXEMPT_HELPERS = ["test/_helpers/postgres-container.ts"];

// Specs that read files or run processes directly or through a non-spec test module. `modules`
// maps every test module path (relative to apps/api: specs and helpers) to its source text.
// Imports are matched by module basename (over-inclusion is safe), to a fixpoint for helpers.
function textReaders(modules) {
  const isSpec = (p) => p.endsWith(".spec.ts");
  const base = (p) => p.replace(/^.*\//, "").replace(/\.(?:ts|js|cjs|mjs)$/, "");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importsAny = (src, names) => names.some((n) => new RegExp(`/${esc(n)}(?:\\.[cm]?[jt]s)?['"]`).test(src));
  const helpers = Object.keys(modules).filter((p) => !isSpec(p) && !EXEMPT_HELPERS.includes(p));
  const readers = new Set(helpers.filter((p) => READ_RE.test(modules[p])));
  for (let changed = true; changed; ) {
    changed = false;
    const names = [...readers].map(base);
    for (const h of helpers) {
      if (!readers.has(h) && importsAny(modules[h], names)) {
        readers.add(h);
        changed = true;
      }
    }
  }
  const names = [...readers].map(base);
  return Object.keys(modules)
    .filter((p) => isSpec(p) && (READ_RE.test(modules[p]) || importsAny(modules[p], names)))
    .sort();
}

// The selection-only probe's summary lines (format of the CLI 1.0.x `testsuite run` output, as in
// main's analysis job beef6cfa: "Found test impact generated by: <url>", "- N <reason>",
// "Selected N test atoms, Skipped M test atoms", "Patching test impact data version: V").
function parseProbe(text) {
  const found = /^Found test impact generated by: (\S+)\s*$/m.exec(text);
  const sel = /^Selected (\d+) test atoms, Skipped (\d+) test atoms\b/m.exec(text);
  const version = /^Patching test impact data version: (\d+)\s*$/m.exec(text);
  const reasons = {};
  if (found) {
    const after = text.slice(found.index);
    const block = sel ? after.slice(0, Math.max(0, sel.index - found.index)) : after;
    for (const m of block.matchAll(/^- (\d+) (.+?)\s*$/gm)) reasons[m[2]] = (reasons[m[2]] ?? 0) + Number(m[1]);
  }
  // CLI 1.0.69018 prints one such line (the first matching path); only that one is read. It only
  // labels a FULL plan, so a second trigger it might omit cannot make a plan IMPACTED.
  const trigger = /^Selecting all test atoms, 'full-test-run-paths' detected modified file: (.+?)\s*$/m.exec(text);
  return {
    impactSource: found ? found[1] : null,
    impactVersion: version ? Number(version[1]) : null,
    selected: sel ? Number(sel[1]) : null,
    skipped: sel ? Number(sel[2]) : null,
    reasons,
    analysisStarted: /^(Analyzing \d+ test atoms|Running impact analysis for)/m.test(text),
    // The CLI names the full-test-run path (relative to apps/api) that made it select everything.
    fullRunTrigger: trigger ? trigger[1] : null,
  };
}

// A full-test-run path as the CLI prints it (relative to apps/api) to a repo-relative path, or
// null when it leaves the repository.
function repoPath(fromApi) {
  const p = path.posix.normalize(`${API_PREFIX}${fromApi}`);
  return p.startsWith("../") || p.startsWith("/") ? null : p;
}

// Pure decision. `inp` holds already-read inputs; text inputs are null when the file is missing.
function decide(inp) {
  const reasons = [];
  const plan = {
    mode: FULL,
    reasons,
    sha: inp.sha || null,
    expectedSha: inp.expectedSha || null,
    guard: { decision: inp.guard?.decision ?? null, reason: inp.guard?.reason ?? null, head: inp.guard?.head ?? null },
    impact: null,
    counts: { discovered: null, listTests: null, mustRun: null, mustRunAdded: null, changedSpecs: null, planned: null },
    mustRun: [],
    atoms: [],
  };
  const fail = (why) => {
    reasons.push(why);
    return plan;
  };

  if (!inp.sha || !SHA_RE.test(inp.sha)) return fail(`CIRCLE_SHA1 is not a full SHA ('${inp.sha || ""}')`);
  if (inp.sha !== inp.expectedSha) return fail(`CIRCLE_SHA1 ${inp.sha} is not remote_expected_sha '${inp.expectedSha || ""}'`);

  const g = inp.guard;
  if (!g || g.decision !== "TIA_ELIGIBLE") return fail(`guard decision ${g?.decision ?? "missing"}${g?.reason ? `: ${g.reason}` : ""}`);
  if (g.head !== inp.sha) return fail(`guard head ${g.head || "none"} is not ${inp.sha}`);
  if (!Array.isArray(g.mustRun)) return fail("guard must-run list missing or invalid");
  if (!Array.isArray(inp.guardChanged) || inp.guardChanged.some((p) => typeof p !== "string")) {
    return fail("guard changed-path list missing or invalid");
  }

  if (inp.discoveredText === null) return fail("no discovered.txt (jest --listTests)");
  const discovered = new Set(lines(inp.discoveredText));
  plan.counts.discovered = discovered.size;
  if (discovered.size === 0) return fail("jest --listTests discovered no spec");
  const badAtom = [...discovered].find((a) => !ATOM_RE.test(a));
  if (badAtom !== undefined) return fail(`discovered atom with an unexpected shape: ${JSON.stringify(badAtom)}`);

  if (inp.listTestsRc !== 0) return fail(`list-tests exit code ${inp.listTestsRc ?? "missing"}`);
  if (inp.selectedText === null) return fail("no selected.txt (list-tests output)");
  const listed = lines(inp.selectedText);
  const unknown = listed.filter((a) => !discovered.has(a));
  if (unknown.length) return fail(`list-tests printed ${unknown.length} line(s) that are not discovered specs, first: ${JSON.stringify(unknown[0])}`);
  const selected = new Set(listed);
  plan.counts.listTests = selected.size;
  if (selected.size === 0) return fail("list-tests selected no spec");

  const missingMustRun = g.mustRun.filter((m) => !discovered.has(m));
  plan.mustRun = [...g.mustRun];
  plan.counts.mustRun = g.mustRun.length;
  if (missingMustRun.length) return fail(`must-run spec not discovered: ${missingMustRun.join(", ")}`);

  if (inp.probeRc !== 0) return fail(`selection probe exit code ${inp.probeRc ?? "missing"}`);
  if (inp.probeText === null) return fail("no probe.log");
  const probe = parseProbe(inp.probeText);
  plan.impact = probe;
  if (probe.analysisStarted) return fail("the selection probe started an impact analysis");
  if (!probe.impactSource) return fail("no impact data found (no 'Found test impact generated by' line)");
  if (probe.selected === null) return fail("probe printed no 'Selected N test atoms, Skipped M test atoms' line");
  if (probe.selected + probe.skipped !== discovered.size) {
    return fail(`probe selected ${probe.selected} + skipped ${probe.skipped} is not the ${discovered.size} discovered specs`);
  }
  const reasonSum = Object.values(probe.reasons).reduce((a, b) => a + b, 0);
  if (Object.keys(probe.reasons).length === 0 || reasonSum !== probe.selected) {
    return fail(`probe per-reason counts add up to ${reasonSum}, not the ${probe.selected} selected`);
  }
  if (probe.selected !== selected.size) return fail(`probe selected ${probe.selected}, list-tests ${selected.size}`);

  if (!Array.isArray(inp.textReaders)) return fail("text-reader specs could not be determined");
  const missingReader = inp.textReaders.find((s) => !discovered.has(s));
  if (missingReader !== undefined) return fail(`text-reader spec not discovered: ${missingReader}`);
  const union = new Set([...selected, ...g.mustRun]);
  plan.counts.mustRunAdded = g.mustRun.filter((m) => !selected.has(m)).length;
  plan.counts.textReaders = inp.textReaders.length;
  plan.counts.textReadersAdded = inp.textReaders.filter((s) => !union.has(s)).length;
  for (const s of inp.textReaders) union.add(s);
  const changedSpecs = inp.guardChanged.filter((p) => p.startsWith(API_PREFIX) && p.endsWith(".spec.ts")).map((p) => p.slice(API_PREFIX.length));
  plan.counts.changedSpecs = changedSpecs.length;
  const unselected = changedSpecs.filter((s) => !union.has(s));
  if (unselected.length) return fail(`changed spec(s) not selected: ${unselected.join(", ")}`);

  plan.counts.planned = union.size;
  if (union.size === discovered.size) {
    // RT-921 c15655 item 1: the CLI selected everything because a full-test-run path the branch
    // did not change differs between this checkout and the stored impact data (canary #1094).
    // Either side can be older: main changed the file after the last analysis (wait for
    // tia-main-analysis), or after the branch's base and a newer analysis recorded it (merge
    // origin/main into the branch). The result says nothing about selection. Still FULL; labelled.
    const trigger = probe.fullRunTrigger === null ? null : repoPath(probe.fullRunTrigger);
    if (trigger !== null && !inp.guardChanged.includes(trigger)) {
      plan.impactDataMismatch = { trigger };
      return fail(
        `impact-data mismatch: full-test-run path ${trigger} differs between this checkout and the stored impact data, and the branch did not change it (inconclusive: wait for tia-main-analysis to cover the merge-base, or merge origin/main if main changed it after the base)`,
      );
    }
    return fail("the selection covers every spec");
  }
  plan.mode = IMPACTED;
  plan.atoms = [...union].sort();
  reasons.push(
    `${union.size} of ${discovered.size} specs: ${selected.size} impacted + ${plan.counts.mustRunAdded} must-run + ${plan.counts.textReadersAdded} text-reader`,
  );
  return plan;
}

const readIfExists = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const readRc = (p) => {
  const t = readIfExists(p);
  return t === null || !/^\s*\d+\s*$/.test(t) ? null : Number(t.trim());
};

// Every .ts/.js module under <apiRoot>/test, keyed by its path relative to apiRoot; null on error.
function readTestModules(apiRoot) {
  try {
    const modules = {};
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(apiRoot, rel), { withFileTypes: true })) {
        const p = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p);
        } else if (e.isFile() && /\.(?:ts|js|cjs|mjs)$/.test(e.name)) {
          modules[p] = fs.readFileSync(path.join(apiRoot, p), "utf8");
        }
      }
    };
    walk("test");
    return Object.keys(modules).length ? modules : null;
  } catch {
    return null;
  }
}

function readInputs(out, env, apiRoot) {
  const sha = env.CIRCLE_SHA1 || "";
  const modules = apiRoot ? readTestModules(apiRoot) : null;
  const guard = readGuard(out, sha);
  let guardChanged = null;
  try {
    const g = JSON.parse(readIfExists(path.join(out, "guard.json")) ?? "null");
    guardChanged = Array.isArray(g?.changed) ? g.changed : null;
  } catch {
    guardChanged = null;
  }
  return {
    sha,
    expectedSha: env.EXPECTED_SHA || "",
    guard,
    guardChanged,
    discoveredText: readIfExists(path.join(out, "discovered.txt")),
    selectedText: readIfExists(path.join(out, "selected.txt")),
    listTestsRc: readRc(path.join(out, "list-tests.rc")),
    probeText: readIfExists(path.join(out, "probe.log")),
    probeRc: readRc(path.join(out, "probe.rc")),
    textReaders: modules ? textReaders(modules) : null,
  };
}

function writePlan(out, plan) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "canary-atoms.txt"), plan.atoms.length ? `${plan.atoms.join("\n")}\n` : "");
  fs.writeFileSync(path.join(out, "canary-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
}

function runPlan(out, env, apiRoot) {
  let plan;
  try {
    plan = decide(readInputs(out, env, apiRoot));
  } catch (e) {
    plan = { mode: FULL, reasons: [`selector error: ${e.message}`], atoms: [] };
  }
  writePlan(out, plan);
  console.log(`TIA_CANARY_MODE=${plan.mode}`);
  for (const r of plan.reasons) console.log(`  ${r}`);
  return plan;
}

// Pure check of a finished run against its plan.
function compare(plan, tested, failing, discovered) {
  const expected = plan.mode === IMPACTED ? new Set(plan.atoms) : discovered;
  const omitted = [...expected].filter((s) => !tested.has(s)).sort();
  const unexpected = plan.mode === IMPACTED ? [...tested].filter((s) => !expected.has(s)).sort() : [];
  const problems = [];
  if (expected.size === 0) {
    problems.push(plan.mode === IMPACTED ? "nothing was planned" : "the discovered spec list is unavailable (infrastructure), so omissions cannot be checked");
  }
  if (omitted.length) problems.push(`${omitted.length} planned spec(s) have no result`);
  if (unexpected.length) problems.push(`${unexpected.length} spec(s) ran that the plan did not list`);
  return {
    mode: plan.mode,
    planned: expected.size,
    tested: tested.size,
    failing: [...failing].sort(),
    omitted,
    unexpected,
    ok: problems.length === 0,
    problems,
  };
}

function runVerify(out, junit, apiRoot) {
  let report;
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(out, "canary-plan.json"), "utf8"));
    const discovered = new Set(lines(readIfExists(path.join(out, "discovered.txt")) ?? ""));
    const xml = readJunitAll(junit);
    const { specs, failing } = xml === null ? { specs: new Set(), failing: new Set() } : parseJunit(xml, apiRoot);
    report = { sha: plan.sha ?? null, guard: plan.guard ?? null, impact: plan.impact ?? null, counts: plan.counts ?? null, reasons: plan.reasons, ...compare(plan, specs, failing, discovered) };
    const secs = readRc(path.join(out, "run-seconds"));
    report.runSeconds = secs;
    if (xml === null) report.problems.push(`no JUnit report at ${junit}`);
    report.ok = report.problems.length === 0;
  } catch (e) {
    report = { ok: false, problems: [`verify error: ${e.message}`] };
  }
  fs.writeFileSync(path.join(out, "canary-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`TIA canary ${report.mode ?? "?"}: planned ${report.planned ?? "?"}, tested ${report.tested ?? "?"}, failing ${report.failing?.length ?? "?"}, run ${report.runSeconds ?? "?"} s`);
  for (const s of report.failing ?? []) console.log(`  FAILING ${s}`);
  for (const p of report.problems) console.log(`  PROBLEM ${p}`);
  return report;
}

function readJunitAll(p) {
  if (!p || !fs.existsSync(p)) return null;
  if (!fs.statSync(p).isDirectory()) return fs.readFileSync(p, "utf8");
  const files = fs.readdirSync(p).filter((f) => f.endsWith(".xml")).sort();
  return files.length ? files.map((f) => fs.readFileSync(path.join(p, f), "utf8")).join("\n") : null;
}

function main(argv, env) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const out = arg("--out", "/tmp/tia");
  const apiRoot = arg("--api-root", process.cwd());
  if (argv[0] === "plan") {
    runPlan(out, env, apiRoot);
    return 0;
  }
  if (argv[0] === "verify") return runVerify(out, arg("--junit", "/tmp/test-reports"), apiRoot).ok ? 0 : 1;
  console.log("usage: tia-canary-select.cjs plan|verify --out <dir> ...");
  return 2;
}

module.exports = { repoPath, IMPACTED, FULL, ATOM_RE, READ_RE, EXEMPT_HELPERS, textReaders, readTestModules, parseProbe, decide, compare, readInputs, runPlan, runVerify, main };

if (require.main === module) process.exit(main(process.argv.slice(2), process.env));
