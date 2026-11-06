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

test("config.yml: scope once, split shards with coverage, fan-in merge; PRs to main only, no serial group", () => {
  const cfg = readText(".circleci/config.yml");
  assert.match(cfg, /\n {2}api_jest_gate_enabled:\n {4}type: boolean\n {4}default: true\n/);
  const jobs = cfg.slice(cfg.indexOf("\n  api-jest-scope:\n"), cfg.indexOf("\n  # RT-981: the db and worker suites"));
  const scopeJob = jobs.slice(0, jobs.indexOf("\n  api-jest-shard:\n"));
  const shard = jobs.slice(jobs.indexOf("\n  api-jest-shard:\n"), jobs.indexOf("\n  api-jest-gate:\n"));
  const gate = jobs.slice(jobs.indexOf("\n  api-jest-gate:\n"));
  assert.match(scopeJob, /- checkout\n {6}- api-gate-guard\n {6}- persist_to_workspace:\n {10}root: \/tmp\/gate\n {10}paths:\n {12}- scope\.txt\n/);
  // Shards: the one scope decision, setup, timing split of the FULL list, coverage json, no per-node floors.
  assert.match(shard, /parallelism: 3\n/);
  assert.match(shard, /- api-gate-scope-skip\n {6}- checkout\n {6}- backend-setup\n/);
  assert.ok(shard.includes('circleci tests split --split-by=timings --timings-type=filename < "$d/discovered.txt" > "$d/assigned.txt"'));
  assert.ok(shard.includes('jest --runTestsByPath "${atoms[@]}" --coverage'));
  assert.ok(shard.includes("--coverageReporters=json --coverageDirectory=\"$d/cov\" --coverageThreshold='{}'"));
  assert.match(shard, /exit \$rc\n {6}- persist_to_workspace:\n {10}root: \/tmp\/gate\n {10}paths:\n {12}- nodes\n {6}- store_test_results:/);
  assert.doesNotMatch(shard, /--run-tests=impacted|--findRelatedTests|store_artifacts|step halt/);
  // The fan-in is the job the verifier reads; it enforces the floors from jest.config.cjs itself.
  assert.match(gate, /- api-gate-scope-skip\n {6}- checkout\n {6}- run:/);
  assert.ok(gate.includes('node .circleci/scripts/api-gate-merge.cjs /tmp/gate services/backend-core/apps/api/jest.config.cjs "$head"'));
  assert.doesNotMatch(gate, /step halt|store_artifacts/);
  // One scope decision: only the skip command halts, and only on `out`.
  const skip = cfg.slice(cfg.indexOf("\n  api-gate-scope-skip:\n"), cfg.indexOf("\n  # RT-1036: Node from the root .nvmrc"));
  assert.ok(skip.includes('out) echo "Out of scope: nothing to run."; circleci-agent step halt ;;'));
  assert.ok(skip.includes("*) echo \"No valid scope decision ('$scope'); refusing to run.\"; exit 1 ;;"));
  const guard = cfg.slice(cfg.indexOf("\n  api-gate-guard:\n"), cfg.indexOf("\n  api-gate-scope-skip:\n"));
  assert.doesNotMatch(guard, /step halt/);
  assert.ok(guard.includes("echo out > /tmp/gate/scope.txt"));
  assert.ok(guard.includes("echo in > /tmp/gate/scope.txt"));
  assert.ok(guard.includes("git diff --quiet refs/remotes/origin/main HEAD -- .circleci/"));
  // pull_request pipeline values only inside the workflow's expression `when` (compile safety).
  const workflows = cfg.slice(cfg.indexOf("\nworkflows:\n"));
  assert.doesNotMatch(cfg.slice(0, cfg.indexOf("\nworkflows:\n")), /pipeline\.event\./);
  const wf = workflows.slice(workflows.indexOf("\n  api-jest-gate:\n"), workflows.indexOf("\n  # RT-981: manual, owner-triggered"));
  assert.match(wf, /when: >-\n {6}pipeline\.parameters\.api_jest_gate_enabled\n {6}and pipeline\.event\.name == "pull_request"\n/);
  assert.match(wf, /and pipeline\.event\.github\.pull_request\.base\.ref == "main"/);
  assert.ok(wf.endsWith("jobs:\n      - api-jest-scope\n      - api-jest-shard:\n          requires:\n            - api-jest-scope: [success, failed]\n      - api-jest-gate:\n          requires:\n            - api-jest-shard: [success, failed]\n"));
  assert.doesNotMatch(wf, /serial-group/);
  assert.equal((cfg.match(/- api-jest-gate:\n/g) || []).length, 1);
});
