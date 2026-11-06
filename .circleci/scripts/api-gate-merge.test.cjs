// RT-1258: offline specs for the split gate's fan-in (api-gate-merge.cjs): coverage merge and
// summary (pinned against istanbul-lib-coverage when installed), Jest's threshold rule, and the
// shard inventory/partition checks that keep the split run equivalent to one full run.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const m = require("./api-gate-merge.cjs");

const loc = (line) => ({ start: { line, column: 0 }, end: { line, column: 10 } });
// One file: 3 statements (lines 1, 1, 2), 2 functions, 1 branch with 2 arms.
function fileCov(s, f, b, p = "/repo/src/a.ts") {
  return {
    path: p,
    statementMap: { 0: loc(1), 1: loc(1), 2: loc(2) },
    fnMap: { 0: { name: "x", decl: loc(1), loc: loc(1) }, 1: { name: "y", decl: loc(2), loc: loc(2) } },
    branchMap: { 0: { type: "if", loc: loc(2), locations: [loc(2), loc(2)] } },
    s: { 0: s[0], 1: s[1], 2: s[2] },
    f: { 0: f[0], 1: f[1] },
    b: { 0: b },
  };
}

test("merge adds hit counts across shards; summary counts like istanbul", () => {
  const a = { "/repo/src/a.ts": fileCov([1, 0, 0], [1, 0], [1, 0]) };
  const b = { "/repo/src/a.ts": fileCov([0, 0, 2], [0, 3], [0, 0]) };
  const merged = m.mergeCoverage([a, b]);
  assert.deepEqual(merged["/repo/src/a.ts"].s, { 0: 1, 1: 0, 2: 2 });
  assert.deepEqual(merged["/repo/src/a.ts"].f, { 0: 1, 1: 3 });
  assert.deepEqual(merged["/repo/src/a.ts"].b, { 0: [1, 0] });
  const s = m.summarize(merged);
  assert.deepEqual([s.statements.covered, s.statements.total], [2, 3]);
  assert.deepEqual([s.functions.covered, s.functions.total], [2, 2]);
  assert.deepEqual([s.branches.covered, s.branches.total], [1, 2]);
  assert.deepEqual([s.lines.covered, s.lines.total], [2, 2]); // line 1 is hit by statement 0
  assert.equal(s.statements.pct, 66.66); // truncated like istanbul, not rounded
});

test("merge refuses shards with different instrumentation", () => {
  const a = { "/repo/src/a.ts": fileCov([1, 0, 0], [1, 0], [1, 0]) };
  const b = { "/repo/src/a.ts": { ...fileCov([1, 0, 0], [1, 0], [1, 0]), statementMap: { 0: loc(1) } } };
  assert.throws(() => m.mergeCoverage([a, b]), /instrumentation mismatch/);
});

// Real Jest output (no node_modules needed, so it runs in CI's contracts/check): two specs run as two
// "shards" over src/idempotency/idempotency.interceptor.ts, and Jest's own coverage-summary total for
// one run of both. Each shard alone covers 31 or 32 of 68 branches; merged and full run cover 36.
test("merged real Jest shard coverage equals Jest's own full-run summary", () => {
  const dir = path.join(__dirname, "fixtures", "api-gate-coverage");
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const merged = m.summarize(m.mergeCoverage([read("n0.coverage-final.json"), read("n1.coverage-final.json")]));
  const full = read("full-run.coverage-summary.json").total;
  for (const k of ["statements", "branches", "functions", "lines"]) {
    assert.deepEqual([merged[k].covered, merged[k].total, merged[k].pct], [full[k].covered, full[k].total, full[k].pct], k);
  }
  const single = m.summarize(read("n0.coverage-final.json"));
  assert.ok(single.branches.covered < merged.branches.covered, "the fixture must exercise a real merge");
});

test("summary matches istanbul-lib-coverage when it is installed", (t) => {
  const pnpm = path.resolve(__dirname, "../../services/backend-core/node_modules/.pnpm");
  const dir = fs.existsSync(pnpm) && fs.readdirSync(pnpm).find((d) => d.startsWith("istanbul-lib-coverage@"));
  if (!dir) return t.skip("istanbul-lib-coverage not installed here");
  const lib = require(path.join(pnpm, dir, "node_modules/istanbul-lib-coverage"));
  const data = m.mergeCoverage([
    { "/repo/src/a.ts": fileCov([3, 0, 1], [1, 0], [2, 0]), "/repo/src/b.ts": fileCov([0, 0, 0], [0, 0], [0, 0], "/repo/src/b.ts") },
    { "/repo/src/a.ts": fileCov([0, 1, 0], [0, 0], [0, 1]) },
  ]);
  const ref = lib.createCoverageMap(JSON.parse(JSON.stringify(data))).getCoverageSummary().data;
  const ours = m.summarize(data);
  for (const k of ["statements", "branches", "functions", "lines"]) {
    assert.deepEqual([ours[k].covered, ours[k].total, ours[k].pct], [ref[k].covered, ref[k].total, ref[k].pct], k);
  }
});

test("thresholds: Jest's rule, global only, anything else fails closed", () => {
  const sum = {
    statements: { pct: 95.5, covered: 955, total: 1000 },
    branches: { pct: 84, covered: 84, total: 100 },
    functions: { pct: 95, covered: 95, total: 100 },
    lines: { pct: 96.01, covered: 9601, total: 10000 },
  };
  const floors = { global: { statements: 95, branches: 84, functions: 95, lines: 96 } };
  assert.deepEqual(m.checkThresholds(sum, floors), []);
  assert.deepEqual(m.checkThresholds({ ...sum, branches: { pct: 83.99, covered: 8399, total: 10000 } }, floors), ["branches 83.99% < 84%"]);
  assert.deepEqual(m.checkThresholds(sum, { global: { statements: -40 } }), ["statements uncovered 45 > 40"]);
  assert.deepEqual(m.checkThresholds(sum, { global: { statements: -50 } }), []);
  assert.match(m.checkThresholds(sum, { ...floors, "./src/x/": { lines: 90 } }).join(";"), /unsupported coverageThreshold key/);
  assert.match(m.checkThresholds(sum, {}).join(";"), /no coverageThreshold\.global/);
  assert.match(m.checkThresholds(sum, { global: { lines: "96" } }).join(";"), /unsupported global threshold/);
});

test("the real jest.config.cjs floors are global-only, the ones this gate enforces", () => {
  const cfg = require(path.resolve(__dirname, "../../services/backend-core/apps/api/jest.config.cjs"));
  assert.deepEqual(Object.keys(cfg.coverageThreshold), ["global"]);
  assert.deepEqual(cfg.coverageThreshold.global, { statements: 95, branches: 84, functions: 95, lines: 96 });
});

const SHA = "a".repeat(40);
const API = path.join(os.tmpdir(), "rt1258-api");
const ok = (specs) => ({
  success: true,
  numFailedTestSuites: 0,
  numRuntimeErrorTestSuites: 0,
  numFailedTests: 0,
  numTotalTestSuites: specs.length,
  testResults: specs.map((s) => ({ name: path.join(API, s) })),
});
const ALL = ["test/a.spec.ts", "test/b.spec.ts", "test/c.spec.ts"];
const node = (index, assigned, over = {}) => ({
  index,
  sha: SHA,
  total: 2,
  discovered: ALL,
  assigned,
  result: ok(assigned),
  coverage: { "/repo/src/a.ts": fileCov([1, 0, 0], [1, 0], [1, 0]) },
  ...over,
});

test("partition: complete, disjoint, same commit, every node present and green", () => {
  assert.deepEqual(m.checkNodes([node(0, ALL.slice(0, 2)), node(1, ALL.slice(2))], SHA, API), []);
  const p = (nodes) => m.checkNodes(nodes, SHA, API).join("; ");
  assert.match(p([node(0, ALL.slice(0, 2))]), /expected nodes 0\.\.1, got \[0\]/);
  assert.match(p([node(0, ALL.slice(0, 2)), node(1, ALL.slice(1))]), /spec assigned twice/);
  assert.match(p([node(0, ALL.slice(0, 1)), node(1, ALL.slice(2))]), /assigned to no node, first: test\/b\.spec\.ts/);
  assert.match(p([node(0, ALL.slice(0, 2)), node(1, ALL.slice(2), { sha: "b".repeat(40) })]), /different commit/);
  assert.match(p([node(0, ALL.slice(0, 2)), node(1, ALL.slice(2), { discovered: ALL.slice(1) })]), /different spec lists/);
  assert.match(p([node(0, ALL.slice(0, 2)), node(1, ALL.slice(2), { result: { ...ok(ALL.slice(2)), numFailedTests: 1 } })]), /node 1: numFailedTests=1/);
  assert.match(p([node(0, ALL.slice(0, 2)), node(1, ALL.slice(2), { result: ok([]) })]), /node 1: .*without a result/);
  assert.match(p([node(0, ALL.slice(0, 2)), node(1, ALL.slice(2), { coverage: null })]), /node 1: no coverage-final\.json/);
  assert.match(p([node(0, ALL.slice(0, 2)), node(1, ["test/z.spec.ts", ...ALL.slice(2)])]), /not discovered/);
  assert.deepEqual(m.checkNodes([], SHA, API), ["no shard results in the workspace"]);
  assert.match(p([node(0, ALL, { total: 0 })]), /bad node total/);
});

test("main: end to end on a workspace, pass then a coverage floor failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt1258-ws-"));
  const write = (n, assigned, cov) => {
    const d = path.join(dir, "nodes", String(n));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "sha"), `${SHA}\n`);
    fs.writeFileSync(path.join(d, "total"), "2\n");
    fs.writeFileSync(path.join(d, "discovered.txt"), ALL.join("\n") + "\n");
    fs.writeFileSync(path.join(d, "assigned.txt"), assigned.join("\n") + "\n");
    fs.writeFileSync(path.join(d, "api-jest.json"), JSON.stringify(ok(assigned)));
    fs.writeFileSync(path.join(d, "coverage-final.json"), JSON.stringify(cov));
  };
  fs.mkdirSync(API, { recursive: true });
  const cfgPath = path.join(API, "jest.config.cjs");
  const log = console.log;
  console.log = () => {};
  try {
    write(0, ALL.slice(0, 2), { "/repo/src/a.ts": fileCov([1, 1, 0], [1, 0], [1, 0]) });
    write(1, ALL.slice(2), { "/repo/src/a.ts": fileCov([0, 0, 1], [0, 1], [0, 1]) });
    fs.writeFileSync(cfgPath, "module.exports = { coverageThreshold: { global: { statements: 100, branches: 100, functions: 100, lines: 100 } } };\n");
    assert.equal(m.main([dir, cfgPath, SHA]), 0);
    write(1, ALL.slice(2), { "/repo/src/a.ts": fileCov([0, 0, 0], [0, 1], [0, 1]) });
    assert.equal(m.main([dir, cfgPath, SHA]), 1);
    assert.equal(m.main([dir, cfgPath, "nope"]), 1);
  } finally {
    console.log = log;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(API, { recursive: true, force: true });
  }
});
