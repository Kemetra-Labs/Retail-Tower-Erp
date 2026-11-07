// RT-1265: offline specs for the Admin Console Vitest gate (job admin-vitest-gate): the scope skip,
// the completeness check and the config wiring. The GitHub-side verifier has its own tests in
// tools/project-graph/tests/test_circleci_gate.py (same scope pattern, pinned there, and pinned
// against the real project graph).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const scope = require("./admin-gate-scope.cjs");
const complete = require("./admin-gate-complete.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

test("scope: only paths that can never select admin/build-test skip; empty or unreadable input runs", () => {
  assert.equal(
    scope.outOfScope([
      "apps/pos/src/a.ts",
      "services/backend-core/apps/api/src/reports/r.ts",
      "apps/admin-console/docs/x.md",
      "apps/admin-console/README.md",
      "docs/x.md",
      "system/releases/a.json",
    ]),
    true,
  );
  for (const p of [
    "apps/admin-console/src/a.tsx",
    "apps/admin-console/tests/unit/a.test.ts",
    "apps/admin-console/src/README.md",
    "apps/admin-console/.github/scripts/r.mjs",
    "services/backend-core/packages/contracts/openapi/openapi.yaml",
    "services/backend-core/apps/api/test/contract-conformance.spec.ts",
    "services/backend-core/.github/workflows/x.yml",
    ".github/workflows/admin-console.yml",
    ".circleci/config.yml",
    "tools/x.py",
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
    assert.equal(scope.main([path.join(os.tmpdir(), "rt1265-missing-file")]), 0);
  } finally {
    console.log = log;
  }
});

const APP = path.join(os.tmpdir(), "rt1265-admin");
const file = (rel, status = "passed") => ({ name: path.join(APP, rel), status });
const okResult = (specs) => ({
  success: true,
  numFailedTestSuites: 0,
  numFailedTests: 0,
  numPassedTests: specs.length * 5,
  numTotalTestSuites: specs.length * 3, // Vitest counts describe blocks, not files
  testResults: specs.map((s) => file(s)),
});
const D = ["tests/unit/a.test.ts", "tests/unit/b/c.test.tsx"];

test("complete: every discovered spec file reported once, nothing failed, coverage written", () => {
  assert.deepEqual(complete.check(okResult(D), D, APP, 100), []);
  // a whole-file skip is not a failure (as `pnpm test` on GitHub)
  const skipped = okResult(D);
  skipped.testResults[1].status = "skipped";
  assert.deepEqual(complete.check(skipped, D, APP, 100), []);
});

test("complete: a short, duplicated, failed, crashed or coverage-less run is incomplete", () => {
  const j = (r, lcov = 100) => complete.check(r, D, APP, lcov).join("; ");
  assert.match(j(okResult([D[0]])), /1 discovered spec\(s\) without a result, first: tests\/unit\/b\/c\.test\.tsx/);
  assert.match(j({ ...okResult(D), testResults: [...okResult(D).testResults, file(D[0])] }), /reported more than once/);
  assert.match(j({ ...okResult(D), testResults: [...okResult(D).testResults, file("tests/unit/x.test.ts")] }), /undiscovered file/);
  const failed = okResult(D);
  failed.testResults[0].status = "failed";
  assert.match(j(failed), /failed: tests\/unit\/a\.test\.ts/);
  assert.match(j({ ...okResult(D), success: false }), /success=false/);
  assert.match(j({ ...okResult(D), numFailedTests: 2 }), /numFailedTests=2/);
  assert.match(j({ ...okResult(D), numFailedTestSuites: 1 }), /numFailedTestSuites=1/);
  assert.match(j(okResult(D), 0), /no coverage report/);
  // every file skipped (or empty): no test ran and passed
  const allSkipped = { ...okResult(D), numPassedTests: 0, testResults: D.map((s) => file(s, "skipped")) };
  assert.match(j(allSkipped), /numPassedTests=0: no test ran and passed/);
  assert.match(j({ ...okResult(D), numPassedTests: undefined }), /no test ran and passed/);
  assert.deepEqual(complete.check(okResult([]), [], APP, 100), [
    "no spec discovered",
    "numPassedTests=0: no test ran and passed",
  ]);
  assert.deepEqual(complete.check(null, D, APP, 100), ["no Vitest JSON result"]);
});

test("complete: discovery matches vitest.config.ts include and finds the real suite", () => {
  const cfg = readText("apps/admin-console/vitest.config.ts");
  assert.match(cfg, /include: \["tests\/unit\/\*\*\/\*\.test\.ts", "tests\/unit\/\*\*\/\*\.test\.tsx"\],/);
  assert.doesNotMatch(cfg, /thresholds/); // no floor today; the gate adds none
  const found = complete.discover(path.join(ROOT, "apps/admin-console"));
  assert.ok(found.length >= 200, `found ${found.length}`);
  assert.ok(found.every((p) => /^tests\/unit\/.+\.test\.tsx?$/.test(p)));
  assert.deepEqual(found, [...found].sort());
});

test("config.yml: the Admin gate runs the full suite with coverage once, on PRs to main only", () => {
  const cfg = readText(".circleci/config.yml");
  assert.match(cfg, /\n {2}admin_vitest_gate_enabled:\n {4}type: boolean\n {4}default: true\n/);
  const job = cfg.slice(cfg.indexOf("\n  admin-vitest-gate:\n    machine:"), cfg.indexOf("\n  # RT-1036: the Admin Console Playwright suite"));
  assert.match(job, /- checkout\n {6}- admin-gate-guard\n {6}- node-toolchain:\n {10}app_dir: apps\/admin-console\n/);
  assert.match(job, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(job, /pnpm exec vitest run --coverage --reporter=default \\\n\s+--reporter=json --outputFile\.json=\/tmp\/gate\/admin-vitest\.json \\\n\s+--reporter=junit --outputFile\.junit=\/tmp\/test-reports\/admin-vitest\.xml \|\| rc=\$\?/);
  assert.match(job, /admin-gate-complete\.cjs \/tmp\/gate\/admin-vitest\.json "\$PWD" \|\| rc=1\n\s+exit \$rc/);
  assert.doesNotMatch(job, /parallelism|tests split|testsuite|store_artifacts|thresholds|step halt|--changed|--related/);
  assert.equal((job.match(/vitest run/g) || []).length, 1);
  const guard = cfg.slice(cfg.indexOf("\n  admin-gate-guard:\n"), cfg.indexOf("\n  # RT-1258 (owner decision, comment 15863): the plan of the API gate"));
  assert.equal((guard.match(/circleci-agent step halt/g) || []).length, 1);
  assert.match(guard, /node \.circleci\/scripts\/admin-gate-scope\.cjs \/tmp\/gate\/changed\.txt \|\| rc=\$\?\n\s+if \[ "\$rc" -eq 10 \]; then/);
  assert.match(guard, /git diff --quiet refs\/remotes\/origin\/main HEAD -- \.circleci\//);
  assert.match(guard, /\[ "\$head" != "\$PIPELINE_REVISION" \] \|\| \[ "\$\{CIRCLE_SHA1:-\}" != "\$head" \]/);
  const outsideWhen = cfg.slice(0, cfg.indexOf("\nworkflows:\n"));
  assert.doesNotMatch(outsideWhen, /pipeline\.event\./);
  const workflows = cfg.slice(cfg.indexOf("\nworkflows:\n"));
  const wf = workflows.slice(workflows.indexOf("\n  admin-vitest-gate:\n"), workflows.indexOf("\n  # RT-1256: the automatic API Jest gate"));
  assert.match(wf, /when: >-\n {6}pipeline\.parameters\.admin_vitest_gate_enabled\n {6}and pipeline\.event\.name == "pull_request"\n/);
  assert.match(wf, /and pipeline\.event\.github\.pull_request\.base\.ref == "main"/);
  assert.match(wf, /jobs:\n {6}- admin-vitest-gate\n$/);
  assert.equal((cfg.match(/- admin-vitest-gate\n/g) || []).length, 1);
});
