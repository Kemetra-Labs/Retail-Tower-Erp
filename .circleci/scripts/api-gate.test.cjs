// RT-1256: offline specs for the automatic API Jest gate (job api-jest-gate): the scope skip, the
// run-completeness check and the config wiring. The GitHub-side verifier has its own tests in
// tools/project-graph/tests/test_circleci_gate.py (same scope pattern, pinned there).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const scope = require("./api-gate-scope.cjs");
const complete = require("./api-gate-complete.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

test("scope: only all-out-of-scope paths skip; empty or unreadable input runs", () => {
  assert.equal(scope.outOfScope(["apps/pos/src/a.ts", "docs/x.md", "system/releases/a.json"]), true);
  assert.equal(scope.outOfScope(["integrations/erpnext-connector/x.py", "tests/e2e/a.spec.ts", "README.md"]), true);
  for (const p of [
    "services/backend-core/apps/api/src/a.ts",
    "apps/pos/.github/workflows/x.yml",
    "apps/admin-console/.github/scripts/r.mjs",
    "integrations/erpnext-connector/.github/x.yml",
    ".github/workflows/backend-core.yml",
    ".circleci/config.yml",
    "tools/x.py",
    ".nvmrc",
    "package.json",
    "README.md.bak",
  ]) {
    assert.equal(scope.outOfScope(["apps/pos/src/a.ts", p]), false, p);
  }
  assert.equal(scope.outOfScope([]), false);
  assert.equal(scope.outOfScope(["", "  "]), false);
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(scope.main([path.join(os.tmpdir(), "rt1256-missing-file")]), 0);
  } finally {
    console.log = log;
  }
});

const API = path.join(os.tmpdir(), "rt1256-api");
const spec = (rel, extra = {}) => ({ name: path.join(API, rel), status: "passed", ...extra });
const okResult = (specs) => ({
  success: true,
  numFailedTestSuites: 0,
  numRuntimeErrorTestSuites: 0,
  numFailedTests: 0,
  numTotalTestSuites: specs.length,
  testResults: specs.map((s) => spec(s)),
});

test("complete: every discovered spec has a result and nothing failed", () => {
  const d = ["test/a.spec.ts", "test/b/c.spec.ts"];
  assert.deepEqual(complete.check(okResult(d), d, API), []);
});

test("complete: a short, empty, failed or crashed run is incomplete", () => {
  const d = ["test/a.spec.ts", "test/b/c.spec.ts"];
  const short = okResult(["test/a.spec.ts"]);
  assert.match(complete.check(short, d, API).join("; "), /numTotalTestSuites=1, discovered 2/);
  assert.match(complete.check(short, d, API).join("; "), /1 discovered spec\(s\) without a result, first: test\/b\/c\.spec\.ts/);
  assert.deepEqual(complete.check(okResult([]), [], API), ["no spec discovered"]);
  assert.deepEqual(complete.check(null, d, API), ["no Jest JSON result"]);
  assert.match(complete.check({ ...okResult(d), success: false }, d, API).join(";"), /success=false/);
  assert.match(complete.check({ ...okResult(d), numFailedTests: 2 }, d, API).join(";"), /numFailedTests=2/);
  assert.match(complete.check({ ...okResult(d), numRuntimeErrorTestSuites: 1 }, d, API).join(";"), /numRuntimeErrorTestSuites=1/);
});

test("config.yml: the gate runs the full API suite with coverage, on PRs to main only, no serial group", () => {
  const cfg = readText(".circleci/config.yml");
  assert.match(cfg, /\n {2}api_jest_gate_enabled:\n {4}type: boolean\n {4}default: true\n/);
  const job = cfg.slice(cfg.indexOf("\n  api-jest-gate:\n    machine:"), cfg.indexOf("\n  # RT-981: the db and worker suites"));
  assert.match(job, /- checkout\n {6}- api-gate-guard\n {6}- backend-setup\n/);
  assert.match(job, /node_modules\/\.bin\/jest --coverage --forceExit --json --outputFile=\/tmp\/gate\/api-jest\.json \|\| rc=\$\?/);
  assert.match(job, /api-gate-complete\.cjs \/tmp\/gate\/api-jest\.json \/tmp\/gate\/discovered\.txt "\$PWD" \|\| rc=1/);
  assert.match(job, /exit \$rc/);
  assert.doesNotMatch(job, /coverageThreshold|--run-tests=impacted|--findRelatedTests|store_artifacts/);
  // The only early exit is the guard's out-of-scope halt; the test step itself never halts.
  assert.doesNotMatch(job, /step halt/);
  const guard = cfg.slice(cfg.indexOf("\n  api-gate-guard:\n"), cfg.indexOf("\n  # RT-1036: Node from the root .nvmrc"));
  assert.equal((guard.match(/circleci-agent step halt/g) || []).length, 1);
  assert.match(guard, /node \.circleci\/scripts\/api-gate-scope\.cjs \/tmp\/gate\/changed\.txt \|\| rc=\$\?\n\s+if \[ "\$rc" -eq 10 \]; then/);
  assert.match(guard, /git diff --quiet refs\/remotes\/origin\/main HEAD -- \.circleci\//);
  // pull_request pipeline values only inside the workflow's expression `when` (compile safety).
  const workflows = cfg.slice(cfg.indexOf("\nworkflows:\n"));
  const outsideWhen = cfg.slice(0, cfg.indexOf("\nworkflows:\n"));
  assert.doesNotMatch(outsideWhen, /pipeline\.event\./);
  const wf = workflows.slice(workflows.indexOf("\n  api-jest-gate:\n"), workflows.indexOf("\n  # RT-981: manual, owner-triggered"));
  assert.match(wf, /when: >-\n {6}pipeline\.parameters\.api_jest_gate_enabled\n {6}and pipeline\.event\.name == "pull_request"\n/);
  assert.match(wf, /and pipeline\.event\.github\.pull_request\.base\.ref == "main"/);
  assert.match(wf, /jobs:\n {6}- api-jest-gate\n$/);
  assert.doesNotMatch(wf, /serial-group/);
  assert.equal((cfg.match(/- api-jest-gate\n/g) || []).length, 1);
});
