// RT-1083: offline tests for tia-shadow-report.cjs, the raw list-tests selection and the
// guarded selection (the RT-1075 guard decision applied).
// Run: node --test ".circleci/scripts/*.test.cjs" (Node 24 runs a bare directory as a file).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main, readGuard } = require("./tia-shadow-report.cjs");

const API_ROOT = "/root/project/services/backend-core/apps/api";
const SHA = "a".repeat(40);
const SPECS = ["test/a.spec.ts", "test/b.spec.ts", "test/c.spec.ts"];

function junit(failing) {
  const suites = SPECS.map((s) => `  <testsuite name="${s}" file="${API_ROOT}/${s}" tests="1" failures="${failing.includes(s) ? 1 : 0}"></testsuite>`);
  return `<?xml version="1.0"?>\n<testsuites>\n${suites.join("\n")}\n</testsuites>\n`;
}

// One fixture run through main(). guard: an object (written as JSON), a string (written
// verbatim), "dir" (a directory named guard.json) or undefined (no file).
function run({ failing = ["test/c.spec.ts"], selected = "test/a.spec.ts\n", rc = 0, guard, discovered = null, junitReports = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tia-report-"));
  const out = path.join(dir, "tia");
  const reports = path.join(dir, "test-reports");
  fs.mkdirSync(out);
  if (junitReports) {
    fs.mkdirSync(reports);
    fs.writeFileSync(path.join(reports, "backend-api-jest-1.xml"), junit(failing));
  }
  fs.writeFileSync(path.join(out, "selected.txt"), selected);
  fs.writeFileSync(path.join(out, "list-tests.rc"), `${rc}\n`);
  if (discovered !== null) fs.writeFileSync(path.join(out, "discovered.count"), `${discovered}\n`);
  const guardPath = path.join(out, "guard.json");
  if (guard === "dir") fs.mkdirSync(guardPath);
  else if (typeof guard === "string") fs.writeFileSync(guardPath, guard);
  else if (guard) fs.writeFileSync(guardPath, `${JSON.stringify(guard)}\n`);

  const log = console.log;
  console.log = () => {};
  const saved = { branch: process.env.CIRCLE_BRANCH, sha: process.env.CIRCLE_SHA1 };
  process.env.CIRCLE_BRANCH = "feature";
  process.env.CIRCLE_SHA1 = SHA;
  try {
    const report = main([path.join(out, "selected.txt"), reports, out, API_ROOT]);
    const json = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
    const text = fs.readFileSync(path.join(out, "report.txt"), "utf8");
    return { report, json, text };
  } finally {
    console.log = log;
    for (const [k, v] of [["CIRCLE_BRANCH", saved.branch], ["CIRCLE_SHA1", saved.sha]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const full = (extra = {}) => ({ branch: "feature", base: "b".repeat(40), head: SHA, decision: "FORCE_FULL", reason: "1 change(s) force the full suite", forcing: [], changed: [], ...extra });
const eligible = (extra = {}) => full({ decision: "TIA_ELIGIBLE", reason: "every change is an added/modified file in the API fast class", ...extra });

// The raw fields exactly as the pre-RT-1083 script reported them for the default fixture.
const RAW_MEASURED = {
  branch: "feature",
  sha: SHA,
  listTestsExitCode: 0,
  totalSpecs: 3,
  failingSpecs: ["test/c.spec.ts"],
  discoveredSpecs: null,
  selectedSpecs: 1,
  selectionRatio: 1 / 3,
  unknownSelected: [],
  misses: ["test/c.spec.ts"],
  status: "measured",
};
const rawFields = (r) => Object.fromEntries(Object.keys(RAW_MEASURED).map((k) => [k, r[k]]));

test("FORCE_FULL: a raw miss becomes 0 guarded misses and the raw miss stays listed", () => {
  const { json, text } = run({ guard: full() });
  assert.deepEqual(json.misses, ["test/c.spec.ts"]);
  assert.equal(json.guard.decision, "FORCE_FULL");
  assert.equal(json.guard.source, "guard.json");
  assert.deepEqual(json.guarded, { status: "force-full", selectedSpecs: 3, selectionRatio: 1, misses: [] });
  assert.match(text, /^guard decision: FORCE_FULL/m);
  assert.match(text, /^GUARDED: selected 3\/3 \(100\.0%\), MISSES 0$/m);
  assert.match(text, /^ {2}MISS test\/c\.spec\.ts$/m);
});

test("TIA_ELIGIBLE: the guarded result is the raw result, raw miss included", () => {
  const { json, text } = run({ guard: eligible() });
  assert.equal(json.guard.decision, "TIA_ELIGIBLE");
  assert.deepEqual(json.guarded, { status: "measured", selectedSpecs: 1, selectionRatio: 1 / 3, misses: ["test/c.spec.ts"] });
  assert.match(text, /^GUARDED: selected 1\/3 \(33\.3%\), MISSES 1$/m);
  assert.match(text, /^ {2}GUARDED MISS test\/c\.spec\.ts$/m);
});

test("TIA_ELIGIBLE keeps the raw empty-selection and all-selected labels", () => {
  assert.equal(run({ guard: eligible(), selected: "" }).json.guarded.status, "empty-selection");
  assert.deepEqual(run({ guard: eligible(), selected: "" }).json.guarded.misses, ["test/c.spec.ts"]);
  assert.equal(run({ guard: eligible(), selected: SPECS.join("\n") }).json.guarded.status, "all-selected");
});

for (const [name, guard, source] of [
  ["missing", undefined, "missing"],
  ["malformed JSON", '{"decision":"FORCE_FULL","reason":"a "quoted" reason"}\n', "unreadable"],
  ["a directory", "dir", "unreadable"],
  ["an unknown decision", full({ decision: "SKIP" }), "invalid-decision"],
  ["no decision", { reason: "x" }, "invalid-decision"],
  ["not an object", "[1,2]\n", "invalid-decision"],
  ["a different head", full({ head: "c".repeat(40) }), "stale-head"],
  ["TIA_ELIGIBLE without a head key", '{"decision":"TIA_ELIGIBLE","reason":"x"}\n', "invalid-decision"],
  ["TIA_ELIGIBLE with head null", eligible({ head: null }), "stale-head"],
  ["TIA_ELIGIBLE with an empty head", eligible({ head: "" }), "stale-head"],
]) {
  test(`guard.json ${name}: FORCE_FULL_UNKNOWN, labelled, never a pass`, () => {
    const { report, json, text } = run({ guard });
    assert.equal(json.guard.decision, "FORCE_FULL_UNKNOWN");
    assert.equal(json.guard.source, source);
    assert.equal(json.guarded.status, "force-full-unknown");
    assert.equal(json.guarded.misses, null);
    assert.notEqual(json.status, "report-error");
    assert.deepEqual(rawFields(report), RAW_MEASURED);
    assert.match(text, /^GUARDED: guard decision unknown, not a measured result$/m);
  });
}

test("the guard step's bash fallback shape is FORCE_FULL from the fallback", () => {
  const { json } = run({ guard: '{"decision":"FORCE_FULL","reason":"guard exited 124"}\n' });
  assert.equal(json.guard.decision, "FORCE_FULL");
  assert.equal(json.guard.source, "fallback");
  assert.equal(json.guard.reason, "guard exited 124");
  assert.equal(json.guard.head, null);
  assert.equal(json.guarded.status, "force-full");
});

test("FORCE_FULL from a guard that could not resolve HEAD (head null) is still FORCE_FULL", () => {
  const { json } = run({ guard: full({ head: null, reason: "cannot resolve HEAD" }) });
  assert.equal(json.guard.decision, "FORCE_FULL");
  assert.equal(json.guard.source, "guard.json");
  assert.equal(json.guarded.status, "force-full");
});

test("TIA_ELIGIBLE with CIRCLE_SHA1 unset is not pinned, so unknown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tia-report-sha-"));
  try {
    fs.writeFileSync(path.join(dir, "guard.json"), JSON.stringify(eligible()));
    const g = readGuard(dir, null);
    assert.equal(g.decision, "FORCE_FULL_UNKNOWN");
    assert.equal(g.source, "stale-head");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FORCE_FULL with a failed list-tests: raw has no selection data, guarded is still computed", () => {
  const { json } = run({ guard: full(), rc: 1 });
  assert.equal(json.status, "no-selection-data");
  assert.equal(json.misses, undefined);
  assert.deepEqual(json.guarded, { status: "force-full", selectedSpecs: 3, selectionRatio: 1, misses: [] });
});

test("TIA_ELIGIBLE with a failed list-tests: guarded has no selection data either", () => {
  const { json, text } = run({ guard: eligible(), rc: 1 });
  assert.equal(json.status, "no-selection-data");
  assert.deepEqual(json.guarded, { status: "no-selection-data", selectedSpecs: null, selectionRatio: null, misses: null });
  assert.match(text, /^GUARDED: no-selection-data; selection ratio and misses not computable$/m);
});

test("no-junit and partial-run are unchanged and still record the guard", () => {
  const noJunit = run({ guard: full(), junitReports: false }).json;
  assert.equal(noJunit.status, "no-junit");
  assert.equal(noJunit.guard.decision, "FORCE_FULL");
  assert.equal(noJunit.guarded, undefined);
  const partial = run({ guard: eligible(), discovered: 10 }).json;
  assert.equal(partial.status, "partial-run");
  assert.equal(partial.guard.decision, "TIA_ELIGIBLE");
  assert.equal(partial.guarded, undefined);
});

test("regression: the raw fields are what the pre-RT-1083 report produced", () => {
  for (const guard of [full(), eligible(), undefined]) {
    assert.deepEqual(rawFields(run({ guard }).report), RAW_MEASURED);
  }
});

test("the script exits 0 even when guard.json cannot be read", () => {
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tia-report-cli-"));
  try {
    fs.mkdirSync(path.join(dir, "guard.json"));
    // No JUnit, no selection, an unreadable guard: every input is bad and the exit code is still 0.
    execFileSync(process.execPath, [path.join(__dirname, "tia-shadow-report.cjs"), path.join(dir, "none.txt"), path.join(dir, "none"), dir, API_ROOT], { stdio: "pipe" });
    const json = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
    assert.equal(json.status, "no-junit");
    assert.equal(json.guard.source, "unreadable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
