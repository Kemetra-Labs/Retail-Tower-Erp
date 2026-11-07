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
  // RT-1258: the plan is made once, after the guard, only while the switch is on (`when`), and persisted with
  // scope.txt. The `unless` branch persists scope.txt alone: switch off is exactly the previous job.
  const COND = "          condition: << pipeline.parameters.api_gate_tia_enabled >>\n          steps:\n";
  assert.match(scopeJob, /- checkout\n {6}- api-gate-guard\n(?: {6}#.*\n)* {6}- when:\n/);
  assert.ok(scopeJob.includes(`      - when:\n${COND}            - api-gate-plan\n            - persist_to_workspace:\n                root: /tmp/gate\n                paths:\n                  - scope.txt\n                  - plan\n`));
  assert.ok(scopeJob.endsWith(`      - unless:\n${COND}            - persist_to_workspace:\n                root: /tmp/gate\n                paths:\n                  - scope.txt\n`));
  // Shards: the one scope decision, setup, timing split of the FULL list, coverage json, no per-node floors.
  assert.match(shard, /parallelism: 3\n/);
  assert.match(shard, /- api-gate-scope-skip\n {6}- checkout\n {6}- backend-setup\n/);
  // The list that is split is the FULL discovered list unless api-gate-plan.cjs accepts an IMPACTED plan.
  assert.ok(shard.includes('src="$d/discovered.txt"'));
  assert.ok(shard.includes('circleci tests split --split-by=timings --timings-type=filename < "$src" > "$d/assigned.txt"'));
  assert.ok(shard.includes('api-gate-plan.cjs select /tmp/gate/plan/plan.json "$d/discovered.txt"'));
  assert.ok(shard.includes('jest --runTestsByPath "${atoms[@]}" --coverage'));
  assert.ok(shard.includes("--coverageReporters=json --coverageDirectory=\"$d/cov\" --coverageThreshold='{}'"));
  assert.match(shard, /exit \$rc\n {6}- persist_to_workspace:\n {10}root: \/tmp\/gate\n {10}paths:\n {12}- nodes\n {6}- store_test_results:/);
  assert.doesNotMatch(shard, /--run-tests=impacted|--findRelatedTests|store_artifacts|step halt/);
  // The fan-in is the job the verifier reads; it enforces the floors from jest.config.cjs itself.
  assert.match(gate, /- api-gate-scope-skip\n {6}- checkout\n(?: {6}#.*\n)* {6}- (?:when|run):/);
  // Switch off compiles to the previous fan-in: the merge step keeps its original name.
  assert.ok(gate.includes('name: "API gate: complete inventory, all shards green, merged coverage vs jest.config.cjs floors"'));
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

// RT-1258 (owner decision, comment 15863): the plan wiring. Planning can only ever degrade to FULL, the
// risk guard alone decides whether anything heavier runs, and the fan-in re-checks the plan.
test("config.yml: the plan is switchable, guard-first, never fails the job, and the fan-in re-checks it", () => {
  const cfg = readText(".circleci/config.yml");
  assert.match(cfg, /\n {2}api_gate_tia_enabled:\n {4}type: boolean\n {4}default: true\n/);
  const cmd = cfg.slice(cfg.indexOf("\n  api-gate-plan:\n"), cfg.indexOf("\n  # RT-1036: Node from the root .nvmrc"));
  assert.ok(cmd.length > 500, "api-gate-plan command found");
  // Planning never fails the job: no step exits non-zero, and each ends in exit 0 or an early skip.
  assert.doesNotMatch(cmd, /exit 1|step halt/);
  // The guard decides first (self-test, then the guard on the whole PR diff); only TIA_ELIGIBLE goes on.
  assert.ok(cmd.includes("tia-risk-guard.test.cjs"));
  assert.ok(cmd.includes('if [ "$decision" = TIA_ELIGIBLE ]; then'));
  assert.ok(cmd.includes('if [ "$(cat /tmp/gate/scope.txt 2>/dev/null)" != in ]; then full "scope is not in"; exit 0; fi'));
  // The two heavy steps skip unless the guard flagged the change eligible, and fall back to FULL on a problem.
  assert.equal((cmd.match(/\[ -f \/tmp\/gate\/plan\/eligible \] \|\| \{ echo "Not eligible: skipped\."; exit 0; \}/g) || []).length, 2);
  assert.ok(cmd.includes('fail "pnpm install failed"'));
  assert.ok(cmd.includes("printf '{\"mode\":\"FULL\",\"reasons\":[\"selector exited %s\"],\"atoms\":[]}\\n' \"$rc\" > /tmp/gate/plan/plan.json"));
  // The plan comes from the existing RT-1239 selector pinned to this exact commit; no second engine.
  assert.ok(cmd.includes('EXPECTED_SHA: "<< pipeline.git.revision >>"'));
  assert.ok(cmd.includes('tia-canary-select.cjs plan --out /tmp/tia --api-root "$PWD"'));
  assert.ok(cmd.includes("cp /tmp/tia/canary-plan.json /tmp/gate/plan/plan.json"));
  assert.ok(cmd.includes('circleci testsuite run "backend api jest" --run-tests=none --analyze-tests=none'));
  assert.doesNotMatch(cmd, /--run-tests=impacted|--run-tests=all|--analyze-tests=impacted/);
  // The fan-in re-runs the guard (for an IMPACTED plan only) before the merge step that judges the plan.
  const gate = cfg.slice(cfg.indexOf("\n  api-jest-gate:\n"), cfg.indexOf("\n  # RT-981: the db and worker suites"));
  const iGuard = gate.indexOf("tia-risk-guard.cjs --repo ~/project --out /tmp/gate/fanin-guard");
  const iMerge = gate.indexOf("node .circleci/scripts/api-gate-merge.cjs");
  assert.ok(iGuard > 0 && iMerge > iGuard, "the independent guard runs before the merge step");
  assert.ok(gate.includes(`grep -q '"mode": "IMPACTED"' /tmp/gate/plan/plan.json`));
  // The shards never read a plan from anywhere but the scope job's workspace, and never narrow on their own.
  const shard = cfg.slice(cfg.indexOf("\n  api-jest-shard:\n"), cfg.indexOf("\n  api-jest-gate:\n"));
  assert.ok(!shard.includes("guard") && !shard.includes("tia-canary-select"));
  // Only the FULL branch measures coverage; the IMPACTED branch must not claim it.
  assert.equal((shard.match(/--coverage /g) || []).length, 2, "the FULL branch of the ON step and the verbatim OFF step");
  // Switch off: the `unless` shard step is the pre-RT-1258 step (no plan, full discovered list, coverage).
  const off = shard.slice(shard.indexOf("- unless:"));
  assert.ok(off.includes('circleci tests split --split-by=timings --timings-type=filename < "$d/discovered.txt" > "$d/assigned.txt"'));
  assert.doesNotMatch(off, /plan|IMPACTED|\$src/);
  const on = shard.slice(shard.indexOf("- when:"), shard.indexOf("- unless:"));
  assert.ok(on.includes("api-gate-plan.cjs select") && on.includes("--coverageThreshold='{}'"));
});
