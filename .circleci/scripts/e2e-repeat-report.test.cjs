// RT-1275: offline specs for the Admin Console E2E repeatability job (job admin-e2e-repeat): input
// validation, the per-test failure-rate summary, the fail-closed completeness check and the config
// wiring. Run with `node --test ".circleci/scripts/*.test.cjs"` (contracts/check runs it on PRs).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const r = require("./e2e-repeat-report.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// The shape of a Playwright JSON report: file suites holding specs (and nested describe suites),
// each spec holding one test per project. With --repeat-each every repeat is its own spec entry.
const spec = (file, line, title, results) => ({
  title,
  file,
  line,
  tests: results.map(([projectName, status]) => ({
    projectName,
    status: status === "passed" ? "expected" : "unexpected",
    results: [{ status }],
  })),
});
const report = (specs, nested = []) => ({
  suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs, suites: nested }],
});

test("validateSpecs: accepts e2e spec files and file:line filters, refuses anything else", () => {
  assert.deepEqual(r.validateSpecs("tests/e2e/a.spec.ts  tests/e2e/sub/b.spec.ts:12"), [
    "tests/e2e/a.spec.ts",
    "tests/e2e/sub/b.spec.ts:12",
  ]);
  for (const bad of [
    "",
    "   ",
    "tests/e2e/../x.spec.ts",
    "tests/unit/a.test.ts",
    "tests/e2e/a.spec.ts;rm -rf /",
    "tests/e2e/a.spec.ts $(id)",
    "/tests/e2e/a.spec.ts",
    "tests/e2e/a.spec.ts:x",
  ]) {
    assert.throws(() => r.validateSpecs(bad), /spec/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("validateRepeat: an integer from 1 to 30", () => {
  assert.equal(r.validateRepeat("10"), 10);
  assert.equal(r.validateRepeat("1"), 1);
  assert.equal(r.validateRepeat("30"), 30);
  for (const bad of ["0", "31", "-1", "2.5", "ten", "", "10 "]) {
    assert.throws(() => r.validateRepeat(bad), /repeat/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("summarize: one row per project, file:line and title, counting runs and failed runs", () => {
  const rows = r.summarize(
    report([
      spec("a.spec.ts", 3, "one", [["chromium-ar", "passed"], ["chromium-en", "passed"]]),
      spec("a.spec.ts", 3, "one", [["chromium-ar", "failed"], ["chromium-en", "passed"]]),
      spec("a.spec.ts", 3, "one", [["chromium-ar", "timedOut"], ["chromium-en", "passed"]]),
      spec("a.spec.ts", 9, "two", [["chromium-ar", "passed"]]),
    ]),
  );
  assert.deepEqual(rows, [
    { key: "chromium-ar|a.spec.ts:3|one", runs: 3, failed: 2 },
    { key: "chromium-ar|a.spec.ts:9|two", runs: 1, failed: 0 },
    { key: "chromium-en|a.spec.ts:3|one", runs: 3, failed: 0 },
  ]);
});

test("summarize: a skipped run is neither a run nor a failure; nested describes are walked", () => {
  const skipped = { title: "s", file: "a.spec.ts", line: 5, tests: [{ projectName: "p", status: "skipped", results: [{ status: "skipped" }] }] };
  const nested = [{ title: "group", file: "a.spec.ts", specs: [spec("a.spec.ts", 7, "deep", [["p", "failed"]])], suites: [] }];
  const rows = r.summarize(report([skipped], nested));
  assert.deepEqual(rows, [{ key: "p|a.spec.ts:7|group > deep", runs: 1, failed: 1 }]);
});

test("summarize: every attempt counts, so a retry that passed still shows the failed attempt", () => {
  const retried = {
    title: "x",
    file: "a.spec.ts",
    line: 1,
    tests: [{ projectName: "p", status: "flaky", results: [{ status: "failed" }, { status: "passed" }] }],
  };
  assert.deepEqual(r.summarize(report([retried])), [{ key: "p|a.spec.ts:1|x", runs: 2, failed: 1 }]);
});

test("check: an empty run, or a requested spec file with no result, fails closed", () => {
  assert.match(r.check({ rows: [], specs: ["tests/e2e/a.spec.ts"] }).join("\n"), /no test ran/);
  const rows = [{ key: "p|a.spec.ts:3|one", runs: 10, failed: 0 }];
  assert.deepEqual(r.check({ rows, specs: ["tests/e2e/a.spec.ts"] }), []);
  assert.deepEqual(r.check({ rows, specs: ["tests/e2e/a.spec.ts:3"] }), []);
  assert.match(
    r.check({ rows, specs: ["tests/e2e/a.spec.ts", "tests/e2e/b.spec.ts"] }).join("\n"),
    /tests\/e2e\/b\.spec\.ts.*no result/,
  );
});

test("render: failing tests first, with their rate; an all-pass run says so", () => {
  const md = r.render([
    { key: "p|a.spec.ts:9|two", runs: 10, failed: 0 },
    { key: "p|a.spec.ts:3|one", runs: 10, failed: 3 },
  ]);
  const lines = md.split("\n");
  const one = lines.findIndex((l) => l.includes("a.spec.ts:3"));
  const two = lines.findIndex((l) => l.includes("a.spec.ts:9"));
  assert.ok(one > 0 && one < two, md);
  assert.match(lines[one], /\| 3 \| 10 \| 30\.0% \|/);
  assert.match(md, /1 of 2 test\(s\) failed at least once/);
  assert.match(r.render([{ key: "p|a.spec.ts:9|two", runs: 10, failed: 0 }]), /No failed attempt/);
});

test("config: admin-e2e-repeat is main-only, off by default, retries off and never a gate", () => {
  const cfg = readText(".circleci/config.yml");
  // Off by default.
  assert.match(cfg, /\n  admin_e2e_repeat:\n    type: boolean\n    default: false\n/);
  // The workflow needs the switch and the main branch, and no other manual route.
  const wf = cfg.slice(cfg.indexOf("\n  admin-e2e-repeat:\n    when:"));
  assert.ok(wf.length > 0 && cfg.includes("\n  admin-e2e-repeat:\n    when:"), "workflow admin-e2e-repeat");
  const when = wf.slice(0, wf.indexOf("    jobs:"));
  assert.match(when, /<< pipeline\.parameters\.admin_e2e_repeat >>/);
  assert.match(when, /equal: \[main, << pipeline\.git\.branch >>\]/);
  assert.match(when, /equal: \[none, << pipeline\.parameters\.remote_suite >>\]/);
  assert.match(wf, /serial-group: << pipeline\.project\.slug >>\/admin-e2e-repeat/);
  // The main analysis must not also start on a repeat pipeline (it would spend credits).
  const tia = cfg.slice(cfg.indexOf("\n  tia-main-analysis:\n    when:"));
  assert.match(tia.slice(0, tia.indexOf("    jobs:")), /not: << pipeline\.parameters\.admin_e2e_repeat >>/);
  // The job: retries off, repeats, JUnit for Test Insights, and no status or artifact upload.
  const job = cfg.slice(cfg.indexOf("\n  admin-e2e-repeat:\n    machine:"));
  const body = job.slice(0, job.indexOf("\n  remote-pos:"));
  assert.ok(body.length > 0, "job admin-e2e-repeat before remote-pos");
  assert.match(body, /--retries=0/);
  assert.match(body, /--repeat-each=/);
  assert.match(body, /e2e-repeat-report\.cjs validate/);
  assert.match(body, /store_test_results/);
  assert.doesNotMatch(body, /store_artifacts|statuses|GITHUB_TOKEN|context:/);
});
