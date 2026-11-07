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

// RT-1258 (owner decision, comment 15863): IMPACTED runs. The fan-in accepts a plan only when the
// shards' inventory is exactly the plan, an independent guard agrees, and nothing else is in doubt;
// anything it cannot trust is the full-suite check with the coverage floors, as before.
const plansApi = require("./api-gate-plan.cjs");
const MUST = "test/tooling/changelog-fragments.spec.ts";
const SPECS = [...ALL, MUST];
const IMPACTED_ATOMS = ["test/a.spec.ts", MUST];
const planObj = (over = {}) => ({
  mode: "IMPACTED",
  sha: SHA,
  guard: { decision: "TIA_ELIGIBLE", head: SHA },
  mustRun: [MUST],
  atoms: IMPACTED_ATOMS,
  ...over,
});
const guardObj = (over = {}) => ({
  decision: "TIA_ELIGIBLE",
  head: SHA,
  changed: [`${plansApi.API_PREFIX}test/a.spec.ts`],
  mustRun: [MUST],
  ...over,
});

// A workspace as the shards and the scope job leave it. `coverage` writes a per-node coverage map
// (what a FULL shard persists); `failNode` makes that node's Jest result report a failed test.
function workspace({ plan, guard, nodes, coverage = null, failNode = -1 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt1258-imp-"));
  const put = (rel, content) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content));
  };
  if (plan !== undefined) put("plan/plan.json", plan);
  if (guard !== undefined) put("fanin-guard/guard.json", guard);
  nodes.forEach((assigned, n) => {
    put(`nodes/${n}/sha`, `${SHA}\n`);
    put(`nodes/${n}/total`, `${nodes.length}\n`);
    put(`nodes/${n}/discovered.txt`, `${SPECS.join("\n")}\n`);
    put(`nodes/${n}/assigned.txt`, assigned.length ? `${assigned.join("\n")}\n` : "");
    put(`nodes/${n}/api-jest.json`, n === failNode ? { ...ok(assigned), numFailedTests: 1, success: false } : ok(assigned));
    if (coverage) put(`nodes/${n}/coverage-final.json`, coverage[n]);
  });
  return dir;
}

function runMain(dir, floors = "{ statements: 100, branches: 100, functions: 100, lines: 100 }") {
  fs.mkdirSync(API, { recursive: true });
  const cfgPath = path.join(API, "jest.config.cjs");
  fs.writeFileSync(cfgPath, `module.exports = { coverageThreshold: { global: ${floors} } };\n`);
  const out = [];
  const log = console.log;
  console.log = (s) => out.push(String(s));
  try {
    return { rc: m.main([dir, cfgPath, SHA]), out: out.join("\n") };
  } finally {
    console.log = log;
    fs.rmSync(API, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("impacted: checkNodes wants exactly the planned specs, once each, and no coverage", () => {
  const imp = (nodes) => m.checkNodes(nodes, SHA, API, { expected: IMPACTED_ATOMS });
  const n = (index, assigned, over = {}) => node(index, assigned, { discovered: SPECS, coverage: null, ...over });
  assert.deepEqual(imp([n(0, ["test/a.spec.ts"]), n(1, [MUST])]), []);
  assert.deepEqual(imp([n(0, IMPACTED_ATOMS), n(1, [])]), [], "a node with nothing assigned is fine");
  const p = (nodes) => imp(nodes).join("; ");
  assert.match(p([n(0, ["test/a.spec.ts"]), n(1, [])]), /1 planned spec\(s\) assigned to no node, first: test\/tooling\/changelog-fragments\.spec\.ts/);
  assert.match(p([n(0, ["test/a.spec.ts", "test/b.spec.ts"]), n(1, [MUST])]), /1 assigned spec\(s\) not in the plan, first: test\/b\.spec\.ts/);
  assert.match(p([n(0, ["test/a.spec.ts", MUST]), n(1, [MUST])]), /spec assigned twice/);
  assert.match(p([n(0, ["test/a.spec.ts"]), n(1, [MUST], { result: { ...ok([MUST]), numFailedTests: 1 } })]), /node 1: numFailedTests=1/);
  assert.match(p([n(0, IMPACTED_ATOMS)]), /expected nodes 0\.\.1, got \[0\]/);
  // Without `expected`, the full inventory and per-node coverage are still required.
  assert.match(m.checkNodes([node(0, ALL.slice(0, 2), { coverage: null }), node(1, ALL.slice(2))], SHA, API).join(";"), /no coverage-final\.json/);
});

test("expectation: FULL unless a valid plan is confirmed by the independent guard", () => {
  const exp = (plan, guard) => {
    const dir = workspace({ plan, guard, nodes: [[]] });
    try {
      return m.expectation(dir, SHA, SPECS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(exp(undefined, undefined).mode, "FULL");
  assert.equal(exp("{broken", undefined).mode, "FULL");
  assert.equal(exp({ mode: "FULL", atoms: [] }, guardObj()).mode, "FULL");
  const stale = exp(planObj({ sha: "c".repeat(40) }), guardObj());
  assert.equal(stale.mode, "FULL");
  assert.match(stale.note, /impacted plan not accepted, full run: .*plan is for c+/);
  assert.deepEqual(stale.problems, []);
  const good = exp(planObj(), guardObj());
  assert.deepEqual([good.mode, good.problems, good.atoms], ["IMPACTED", [], IMPACTED_ATOMS]);
  assert.match(exp(planObj(), undefined).problems.join(";"), /no independent risk guard result/);
  assert.match(exp(planObj(), guardObj({ decision: "FORCE_FULL" })).problems.join(";"), /impacted plan rejected: independent risk guard says FORCE_FULL/);
  assert.match(exp(planObj(), guardObj({ changed: [`${plansApi.API_PREFIX}test/b.spec.ts`] })).problems.join(";"), /changed spec\(s\) not in the plan: test\/b\.spec\.ts/);
  assert.match(exp(planObj(), guardObj({ mustRun: [] })).problems.join(";"), /must-run list differs/);
});

test("main: an IMPACTED run passes without coverage and says the floors were not evaluated", () => {
  const r = runMain(workspace({ plan: planObj(), guard: guardObj(), nodes: [["test/a.spec.ts"], [MUST]] }));
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /API gate passed \(IMPACTED run, 2 of 4 specs\)/);
  assert.match(r.out, /Global coverage floors were NOT evaluated/);
  assert.doesNotMatch(r.out, /merged coverage/);
});

test("main: every way an IMPACTED run can be short, over, forged or unconfirmed fails the gate", () => {
  const fails = (setup, re) => {
    const r = runMain(workspace(setup));
    assert.equal(r.rc, 1, r.out);
    assert.match(r.out, re, r.out);
  };
  const two = [["test/a.spec.ts"], [MUST]];
  // A planned spec that no node ran, and a node that ran more than the plan (e.g. the full list).
  fails({ plan: planObj(), guard: guardObj(), nodes: [["test/a.spec.ts"], []] }, /planned spec\(s\) assigned to no node/);
  fails({ plan: planObj(), guard: guardObj(), nodes: [SPECS, []] }, /assigned spec\(s\) not in the plan/);
  // A planned spec that failed.
  fails({ plan: planObj(), guard: guardObj(), nodes: two, failNode: 1 }, /node 1: .*numFailedTests=1/);
  // No independent guard result, a guard that no longer says TIA_ELIGIBLE, a changed spec the plan lacks.
  fails({ plan: planObj(), nodes: two }, /impacted plan rejected: no independent risk guard result/);
  fails({ plan: planObj(), guard: guardObj({ decision: "FORCE_FULL", reason: "1 change(s) force the full suite" }), nodes: two }, /impacted plan rejected: independent risk guard says FORCE_FULL/);
  fails({ plan: planObj(), guard: guardObj({ changed: [`${plansApi.API_PREFIX}test/d.spec.ts`] }), nodes: two }, /changed spec\(s\) not in the plan: test\/d\.spec\.ts/);
  // A plan for another commit is not accepted as IMPACTED: the run must then be the full suite, so an
  // impacted-sized inventory is short.
  fails({ plan: planObj({ sha: "c".repeat(40) }), guard: guardObj(), nodes: two }, /impacted plan not accepted, full run[^]*assigned to no node/);
});

test("main: FULL (no plan, a FULL plan, a stale plan) still merges coverage and enforces the floors", () => {
  const cov = (...s) => ({ "/repo/src/a.ts": fileCov(s, [1, 1], [1, 1]) });
  const full = (plan) => ({ plan, guard: guardObj(), nodes: [SPECS.slice(0, 3), SPECS.slice(3)], coverage: [cov(1, 1, 1), cov(1, 1, 1)] });
  const floorsMet = "{ statements: 100, branches: 100, functions: 100, lines: 100 }";
  for (const [name, plan] of [["no plan", undefined], ["a FULL plan", { mode: "FULL", atoms: [] }], ["a stale impacted plan", planObj({ sha: "c".repeat(40) })]]) {
    const r = runMain(workspace(full(plan)), floorsMet);
    assert.equal(r.rc, 0, `${name}: ${r.out}`);
    assert.match(r.out, /merged coverage: statements 100%/, name);
    assert.match(r.out, /coverage floors met/, name);
    assert.doesNotMatch(r.out, /IMPACTED run/, name);
  }
  // The floors still fail a FULL run, with or without a plan file.
  const low = (plan) => ({ ...full(plan), coverage: [cov(1, 0, 0), cov(0, 0, 0)] });
  for (const plan of [undefined, { mode: "FULL", atoms: [] }]) {
    const r = runMain(workspace(low(plan)), floorsMet);
    assert.equal(r.rc, 1);
    assert.match(r.out, /statements 33\.33% < 100%/);
  }
  // A FULL plan does not let an impacted-sized inventory through.
  const r = runMain(workspace({ plan: { mode: "FULL", atoms: [] }, guard: guardObj(), nodes: [["test/a.spec.ts"], [MUST]] }));
  assert.equal(r.rc, 1);
  assert.match(r.out, /discovered spec\(s\) assigned to no node/);
});
