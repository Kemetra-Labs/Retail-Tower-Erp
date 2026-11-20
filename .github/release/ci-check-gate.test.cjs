// RT-1471 Phase 2 (POS, POS Pilot, Admin Console, ERPNext-Connector): spec for .github/release/ci-check-gate.cjs, the read-only,
// fail-closed exact-SHA guard for the mandatory CI checks of a release. Run: node --test .github/release/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const gate = require("./ci-check-gate.cjs");

const REPO = "Kemetra-Labs/Retail-Tower-Erp";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const WF = ".github/workflows/pos.yml";
const REQUIRED = [
  { name: "pos/static", workflow: WF },
  { name: "pos/test", workflow: WF },
  { name: "pos/package-windows", workflow: WF },
  { name: "pos/e2e-electron", workflow: WF },
];

/** A workflow run record as `gh api repos/<repo>/actions/runs?head_sha=<sha>` reports it. */
function run(id, overrides = {}) {
  return {
    id,
    path: WF,
    event: "push",
    head_branch: "main",
    head_sha: SHA,
    repository: REPO,
    head_repository: REPO,
    ...overrides,
  };
}

let nextJob = 5000;

/** A check run, as projected by the workflow's jq. For an Actions job its id is the job id in details_url. */
function check(name, runId, overrides = {}) {
  const id = nextJob++;
  return {
    id,
    name,
    status: "completed",
    conclusion: "success",
    slug: "github-actions",
    started_at: "2026-11-20T10:00:00Z",
    head_sha: SHA,
    details_url: `https://github.com/${REPO}/actions/runs/${runId}/job/${id}`,
    ...overrides,
  };
}

/** The Actions jobs that back the given check runs (what `GET actions/runs/<id>/jobs` reports for them). */
function jobsFor(checks) {
  return checks
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(c.details_url ?? "");
      return {
        id: m ? Number(m[2]) : c.id,
        run_id: m ? Number(m[1]) : undefined,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        head_sha: c.head_sha,
        check_run_url: `https://api.github.com/repos/${REPO}/check-runs/${c.id}`,
      };
    });
}

function good() {
  return {
    checks: REQUIRED.map((r) => check(r.name, 100)),
    runs: [run(100)],
  };
}

function judge(input = good(), over = {}) {
  const jobs = input.jobs ?? (Array.isArray(input.checks) ? jobsFor(input.checks) : []);
  return gate.judgeChecks({ ...input, jobs, required: REQUIRED, sha: SHA, repo: REPO, ...over });
}

function evalGuard(input) {
  const jobs = input.jobs ?? jobsFor(input.checks);
  return gate.evaluateGuard({ ...input, jobs, required: REQUIRED, sha: SHA, repo: REPO });
}

const problemText = (r) => r.problems.join(" | ");

test("passes when every required check is a completed success from the trusted workflow run for the SHA", () => {
  const r = judge();
  assert.deepEqual(r.problems, []);
  assert.equal(r.notes.length, REQUIRED.length);
});

test("refuses a required check that is missing", () => {
  const input = good();
  input.checks = input.checks.filter((c) => c.name !== "pos/package-windows");
  const r = judge(input);
  assert.match(problemText(r), /pos\/package-windows.*missing/);
});

for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "neutral", "action_required", "stale", null]) {
  test(`refuses a required check whose conclusion is ${conclusion}`, () => {
    const input = good();
    input.checks[1] = check("pos/test", 100, { conclusion, status: conclusion === null ? "in_progress" : "completed" });
    assert.match(problemText(judge(input)), /pos\/test/);
  });
}

test("refuses a check that is not completed even if it reports success", () => {
  const input = good();
  input.checks[0] = check("pos/static", 100, { status: "in_progress" });
  assert.match(problemText(judge(input)), /pos\/static/);
});

test("refuses a run for another commit (wrong SHA)", () => {
  const input = good();
  input.checks[0] = check("pos/static", 100, { head_sha: OTHER_SHA });
  const r = judge(input);
  assert.match(problemText(r), /pos\/static/);
  assert.match(problemText(r), new RegExp(OTHER_SHA));
});

test("refuses a run with no head_sha", () => {
  const input = good();
  const c = check("pos/static", 100);
  delete c.head_sha;
  input.checks[0] = c;
  assert.match(problemText(judge(input)), /pos\/static/);
});

test("ignores a check from another app: only github-actions counts, so it is missing", () => {
  const input = good();
  input.checks[0] = check("pos/static", 100, { slug: "circleci-checks" });
  assert.match(problemText(judge(input)), /pos\/static.*missing/);
});

test("refuses a check with no app slug", () => {
  const input = good();
  const c = check("pos/static", 100);
  delete c.slug;
  input.checks[0] = c;
  assert.match(problemText(judge(input)), /pos\/static/);
});

test("a green run from another app does not rescue a red trusted run", () => {
  const input = good();
  input.checks[0] = check("pos/static", 100, { conclusion: "failure" });
  input.checks.push(check("pos/static", 100, { slug: "someone-else", started_at: "2026-11-20T11:00:00Z" }));
  assert.match(problemText(judge(input)), /pos\/static.*failure/);
});

// Provenance: name and app slug alone are not enough.
test("refuses a check whose workflow run is not in the run list", () => {
  const input = good();
  input.runs = [];
  assert.match(problemText(judge(input)), /pos\/static.*run 100/);
});

test("refuses a check with no details_url or a malformed one", () => {
  for (const url of [
    undefined,
    "",
    "https://example.com/actions/runs/100/job/1",
    `https://github.com/${REPO}/actions/runs/abc/job/1`,
    `https://github.com/other/repo/actions/runs/100/job/1`,
    `https://github.com/${REPO}/actions/runs/100/job/6001/extra`,
    `https://github.com/${REPO}/actions/runs/100/job/6001?x=1`,
    `https://github.com/${REPO}/actions/runs/100`,
    `https://github.com/${REPO}/actions/runs/100/job/`,
    `https://github.com/${REPO}/actions/runs/100/job/60a1`,
    ` https://github.com/${REPO}/actions/runs/100/job/6001`,
  ]) {
    const input = good();
    const c = check("pos/static", 100);
    if (url === undefined) delete c.details_url;
    else c.details_url = url;
    input.checks[0] = c;
    assert.match(problemText(judge(input)), /pos\/static/, String(url));
  }
});

test("refuses a run of another workflow file", () => {
  const input = good();
  input.runs = [run(100, { path: ".github/workflows/evil.yml" })];
  assert.match(problemText(judge(input)), /workflow/);
});

test("refuses a pull_request run even when its head SHA equals the release SHA", () => {
  const input = good();
  input.runs = [run(100, { event: "pull_request", head_branch: "feature" })];
  assert.match(problemText(judge(input)), /event|branch/);
});

test("refuses a run on a branch other than main", () => {
  const input = good();
  input.runs = [run(100, { head_branch: "claude/something" })];
  assert.match(problemText(judge(input)), /branch/);
});

test("refuses a run whose own head SHA differs from the release SHA", () => {
  const input = good();
  input.runs = [run(100, { head_sha: OTHER_SHA })];
  assert.match(problemText(judge(input)), /head SHA|run 100/);
});

test("refuses a run from a fork repository", () => {
  const input = good();
  input.runs = [run(100, { head_repository: "attacker/Retail-Tower-Erp" })];
  assert.match(problemText(judge(input)), /repository/);
});

test("accepts each trusted full-run event: push, schedule and workflow_dispatch", () => {
  for (const event of ["push", "schedule", "workflow_dispatch"]) {
    const input = good();
    input.runs = [run(100, { event })];
    assert.deepEqual(judge(input).problems, [], event);
  }
});

test("refuses events that are not a trusted full run (workflow_run, pull_request_target, release)", () => {
  for (const event of ["workflow_run", "pull_request_target", "release", "repository_dispatch", undefined]) {
    const input = good();
    input.runs = [run(100, { event })];
    assert.notDeepEqual(judge(input).problems, [], String(event));
  }
});

test("a trusted green run does not hide an untrusted run of the same check on the same SHA", () => {
  const input = good();
  input.checks.push(check("pos/static", 200, { started_at: "2026-11-20T09:00:00Z" }));
  input.runs.push(run(200, { event: "pull_request", head_branch: "feature" }));
  assert.match(problemText(judge(input)), /pos\/static/);
});

// The check run must be the one GitHub made for an Actions job of that run: a forged or edited check run that
// merely points at a trusted run's URL is refused (RT-1471 review).
test("refuses a check run forged to point at a real job: its id is not that job's id", () => {
  const input = good();
  const real = input.checks[1]; // a real, green pos/test job
  // identical in every field the Checks API lets a forger copy, and newer; only its own id differs
  const forged = check("pos/test", 100, { started_at: "2026-11-20T11:00:00Z", details_url: real.details_url });
  input.checks.push(forged);
  input.jobs = jobsFor(input.checks.filter((c) => c !== forged)); // the job list only has the real job
  assert.match(problemText(judge(input)), /pos\/test.*its id/);
});

test("refuses a forged check run that names its own id as a job of a trusted run", () => {
  const input = good();
  const forged = check("pos/test", 100, { started_at: "2026-11-20T11:00:00Z" });
  forged.details_url = `https://github.com/${REPO}/actions/runs/100/job/${forged.id}`;
  input.checks.push(forged);
  input.jobs = jobsFor(input.checks.filter((c) => c !== forged)); // GitHub has no such job in run 100
  assert.match(problemText(judge(input)), /pos\/test.*job/);
});

test("refuses a check whose job is missing from the job list", () => {
  const input = good();
  input.jobs = jobsFor(input.checks).filter((j) => j.name !== "pos/static");
  assert.match(problemText(judge(input)), /pos\/static.*job/);
});

test("refuses a check that reports success while its Actions job did not", () => {
  const input = good();
  input.jobs = jobsFor(input.checks).map((j) => (j.name === "pos/test" ? { ...j, conclusion: "failure" } : j));
  assert.match(problemText(judge(input)), /pos\/test.*job/);
});

test("refuses when the job disagrees on run, name, head SHA or check run", () => {
  const mutations = {
    "another run": (j) => ({ ...j, run_id: 999 }),
    "another name": (j) => ({ ...j, name: "pos/other" }),
    "another SHA": (j) => ({ ...j, head_sha: OTHER_SHA }),
    "another check run": (j) => ({ ...j, check_run_url: `https://api.github.com/repos/${REPO}/check-runs/1` }),
    "no check run url": (j) => ({ ...j, check_run_url: undefined }),
    "another repository": (j) => ({ ...j, check_run_url: `https://api.github.com/repos/other/repo/check-runs/${j.id}` }),
    "in progress": (j) => ({ ...j, status: "in_progress" }),
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const input = good();
    input.jobs = jobsFor(input.checks).map((j) => (j.name === "pos/static" ? mutate(j) : j));
    assert.match(problemText(judge(input)), /pos\/static/, label);
  }
});

test("refuses unreadable jobs", () => {
  for (const bad of [null, undefined, {}, "x", 7]) {
    const input = good();
    assert.notDeepEqual(gate.judgeChecks({ ...input, jobs: bad, required: REQUIRED, sha: SHA, repo: REPO }).problems, [], String(bad));
  }
});

test("a message never carries a line break, so an attacker's text cannot start a workflow command", () => {
  const input = good();
  input.checks[0] = check("pos/static", 100, { details_url: "https://x/\n::warning::pwned\r::add-mask::y" });
  const r = judge(input);
  for (const line of [...r.problems, ...r.notes]) assert.doesNotMatch(line, /[\r\n]/);
  const res = spawnSync(process.execPath, [path.join(__dirname, "ci-check-gate.cjs"), ...goodArgs(), ...Object.entries(cliFiles(input)).flatMap(([flag, v]) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rt1471-pos-gate-")), "x.json");
    fs.writeFileSync(f, JSON.stringify(v));
    return [flag, f];
  })], { encoding: "utf8" });
  for (const line of res.stdout.split("\n")) assert.doesNotMatch(line, /^::(warning|add-mask|stop-commands)/);
});

// The newest run decides.
test("a newer failed run supersedes an older green run", () => {
  const input = good();
  input.checks.push(check("pos/test", 101, { conclusion: "failure", started_at: "2026-11-20T12:00:00Z" }));
  input.runs.push(run(101, { event: "schedule" }));
  assert.match(problemText(judge(input)), /pos\/test.*failure/);
});

test("a newer green run supersedes an older failed run", () => {
  const input = good();
  input.checks[1] = check("pos/test", 100, { conclusion: "failure", started_at: "2026-11-20T09:00:00Z" });
  input.checks.push(check("pos/test", 101, { started_at: "2026-11-20T12:00:00Z" }));
  input.runs.push(run(101, { event: "workflow_dispatch" }));
  assert.deepEqual(judge(input).problems, []);
});

test("a pending re-run with no started_at is the newest and is not masked by an older green", () => {
  const input = good();
  input.checks.push(check("pos/test", 101, { conclusion: null, status: "queued", started_at: null }));
  input.runs.push(run(101, { event: "schedule" }));
  assert.match(problemText(judge(input)), /pos\/test.*pending/);
});

test("equal-newest runs must all be green, in either array order", () => {
  for (const order of [["success", "failure"], ["failure", "success"]]) {
    const input = good();
    input.checks = input.checks.filter((c) => c.name !== "pos/test");
    order.forEach((conclusion, i) => input.checks.push(check("pos/test", 100 + i, { conclusion, started_at: "2026-11-20T12:00:00Z" })));
    input.runs = [run(100), run(101, { event: "schedule" })];
    assert.match(problemText(judge(input)), /pos\/test/, order.join());
  }
});

// Inputs that cannot be trusted.
test("refuses an invalid release SHA", () => {
  for (const sha of ["", "abc", "A".repeat(40), `${SHA}\n`, "a".repeat(41), undefined, null, 5]) {
    assert.match(problemText(judge(good(), { sha })), /40-character/, String(sha));
  }
});

test("refuses unreadable checks or runs", () => {
  for (const bad of [null, undefined, {}, "x", 7]) {
    assert.notDeepEqual(judge({ checks: bad, runs: [] }).problems, [], `checks ${String(bad)}`);
    assert.notDeepEqual(judge({ checks: [], runs: bad }).problems, [], `runs ${String(bad)}`);
  }
});

test("refuses an empty or malformed required list", () => {
  for (const required of [null, undefined, [], "pos/static", [{ name: "pos/static" }], [{ workflow: WF }], [{ name: "", workflow: WF }], [{ name: "pos/static", workflow: "" }], [null]]) {
    assert.notDeepEqual(judge(good(), { required }).problems, [], JSON.stringify(required));
  }
});

test("refuses an invalid repository", () => {
  for (const repo of ["", undefined, "no-slash", "a/b/c"]) {
    assert.notDeepEqual(judge(good(), { repo }).problems, [], String(repo));
  }
});

test("non-object entries in the lists never throw and never count", () => {
  const input = good();
  input.checks.push(null, 5, "x", []);
  input.runs.push(null, 5, "x", []);
  assert.deepEqual(judge(input).problems, []);
});

test("a run record with a non-string path or event never matches", () => {
  const input = good();
  input.runs = [run(100, { path: { toString: () => WF } })];
  assert.notDeepEqual(judge(input).problems, []);
});

// The manual-proof hint.
test("a missing check prints the exact-SHA proof and runs nothing", () => {
  const input = good();
  input.checks = [];
  const r = evalGuard(input);
  assert.equal(r.verdict, "REFUSED");
  const hint = r.notes.find((n) => n.startsWith("To prove"));
  assert.ok(hint, "expected a proof hint");
  assert.match(hint, new RegExp(`gh workflow run pos\\.yml --ref main -f expected_sha=${SHA}`));
  assert.match(hint, /dispatches nothing/);
});

test("a pending check also prints the hint", () => {
  const input = good();
  input.checks[0] = check("pos/static", 100, { conclusion: null, status: "in_progress" });
  const r = evalGuard(input);
  assert.ok(r.notes.some((n) => n.startsWith("To prove")));
});

test("no hint when something red, wrong-SHA or untrusted sits beside the missing check", () => {
  for (const mutate of [
    (i) => { i.checks[0] = check("pos/static", 100, { conclusion: "failure" }); },
    (i) => { i.checks[0] = check("pos/static", 100, { head_sha: OTHER_SHA }); },
    (i) => { i.runs = [run(100, { event: "pull_request" })]; },
  ]) {
    const input = good();
    input.checks = input.checks.filter((c) => c.name !== "pos/test");
    mutate(input);
    const r = evalGuard(input);
    assert.equal(r.verdict, "REFUSED");
    assert.ok(!r.notes.some((n) => n.startsWith("To prove")), "hint must not mislead");
  }
});

test("no hint for an invalid SHA", () => {
  const r = gate.evaluateGuard({ checks: [], runs: [], jobs: [], required: REQUIRED, sha: "xyz", repo: REPO });
  assert.equal(r.verdict, "REFUSED");
  assert.ok(!r.notes.some((n) => n.startsWith("To prove")));
});

test("the pass verdict carries no hint", () => {
  const r = evalGuard(good());
  assert.equal(r.verdict, "PASS");
  assert.ok(!r.notes.some((n) => n.startsWith("To prove")));
});

// The Admin Console and ERPNext-Connector releases (RT-1471 Phase 2, last slice) use the same guard with their own
// required lists. The script has no product knowledge; these specs pin that the lists work as policy says.
const ADMIN_WF = ".github/workflows/admin-console.yml";
const CONNECTOR_WF = ".github/workflows/erpnext-connector.yml";
const PRODUCTS = {
  admin: { wf: ADMIN_WF, names: ["admin/build-test", "admin/e2e"], proof: "admin-console.yml" },
  connector: { wf: CONNECTOR_WF, names: ["connector/unit-tests-and-lint", "connector/bench"], proof: "erpnext-connector.yml" },
};

function productInput(p, over = {}) {
  return {
    checks: p.names.map((n) => check(n, 100)),
    runs: [run(100, { path: p.wf, ...over })],
    required: p.names.map((name) => ({ name, workflow: p.wf })),
  };
}

function productJudge(p, input) {
  return gate.judgeChecks({ ...input, jobs: input.jobs ?? jobsFor(input.checks), sha: SHA, repo: REPO });
}

for (const [key, p] of Object.entries(PRODUCTS)) {
  test(`${key}: passes with every mandatory check green from its own workflow run`, () => {
    assert.deepEqual(productJudge(p, productInput(p)).problems, []);
  });

  test(`${key}: refuses when any one mandatory check is missing, red, cancelled, skipped or pending`, () => {
    for (const target of p.names) {
      const base = productInput(p);
      const cases = {
        missing: base.checks.filter((c) => c.name !== target),
        failure: base.checks.map((c) => (c.name === target ? { ...c, conclusion: "failure" } : c)),
        cancelled: base.checks.map((c) => (c.name === target ? { ...c, conclusion: "cancelled" } : c)),
        skipped: base.checks.map((c) => (c.name === target ? { ...c, conclusion: "skipped" } : c)),
        pending: base.checks.map((c) => (c.name === target ? { ...c, status: "in_progress", conclusion: null } : c)),
      };
      for (const [label, checks] of Object.entries(cases)) {
        const r = productJudge(p, { ...base, checks });
        assert.ok(r.problems.length > 0, `${key} ${target} ${label} must refuse`);
        assert.ok(problemText(r).includes(`'${target}'`), `${key} ${target} ${label} must name the check`);
      }
    }
  });

  test(`${key}: a run of another product's workflow cannot satisfy the list`, () => {
    for (const other of [".github/workflows/pos.yml", ADMIN_WF, CONNECTOR_WF, ".github/workflows/backend-core.yml"].filter((w) => w !== p.wf)) {
      const input = productInput(p);
      input.runs = [run(100, { path: other })];
      assert.match(problemText(productJudge(p, input)), /not \.github\/workflows\//, other);
    }
  });

  test(`${key}: a pull_request, fork or feature-branch run of its own workflow is refused`, () => {
    for (const over of [{ event: "pull_request" }, { head_branch: "claude/x" }, { head_repository: "attacker/repo" }, { head_sha: OTHER_SHA }]) {
      assert.ok(productJudge(p, productInput(p, over)).problems.length > 0, JSON.stringify(over));
    }
  });

  test(`${key}: a missing check prints the proof of its own workflow only`, () => {
    const input = productInput(p);
    input.checks = [];
    const r = gate.evaluateGuard({ ...input, jobs: [], sha: SHA, repo: REPO });
    const hints = r.notes.filter((n) => n.startsWith("To prove"));
    assert.equal(hints.length, 1);
    assert.ok(hints[0].includes(`gh workflow run ${p.proof} --ref main -f expected_sha=${SHA}`), hints[0]);
    assert.equal((hints[0].match(/gh workflow run /g) ?? []).length, 1, "one command, for this product only");
  });
}

test("connector: the name must match exactly, a lane job named connector/bench lane v16 is not connector/bench", () => {
  const p = PRODUCTS.connector;
  const input = productInput(p);
  input.checks = [check(p.names[0], 100), check("connector/bench lane v16", 100)];
  const r = productJudge(p, input);
  assert.match(problemText(r), /'connector\/bench' is 'missing'/);
});

test("connector: a red lane job does not decide the aggregate check, only connector/bench does", () => {
  const p = PRODUCTS.connector;
  const input = productInput(p);
  input.checks.push(check("connector/bench lane v16", 100, { conclusion: "failure" }));
  assert.deepEqual(productJudge(p, input).problems, [], "the required names are judged exactly");
  input.checks = input.checks.map((c) => (c.name === "connector/bench" ? { ...c, conclusion: "failure" } : c));
  assert.ok(productJudge(p, input).problems.length > 0);
});

// CLI.
function cli(args, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt1471-pos-gate-"));
  const full = [...args];
  for (const [flag, value] of Object.entries(files)) {
    const f = path.join(dir, `${flag.slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(value));
    full.push(flag, f);
  }
  const res = spawnSync(process.execPath, [path.join(__dirname, "ci-check-gate.cjs"), ...full], { encoding: "utf8" });
  return { status: res.status, out: res.stdout + res.stderr };
}

function cliFiles(input) {
  return { "--checks": input.checks, "--runs": input.runs, "--jobs": input.jobs ?? jobsFor(input.checks) };
}

function goodArgs() {
  return ["--required", JSON.stringify(REQUIRED), "--sha", SHA, "--repo", REPO];
}

test("CLI passes with exit 0 on good evidence", () => {
  const input = good();
  const r = cli(goodArgs(), cliFiles(input));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS/);
});

test("CLI refuses with exit 1 and an ::error:: line on a failed check", () => {
  const input = good();
  input.checks[0] = check("pos/static", 100, { conclusion: "failure" });
  const r = cli(goodArgs(), cliFiles(input));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::.*pos\/static/);
  assert.match(r.out, /REFUSED/);
});

test("CLI exits 2 when any flag is missing or empty", () => {
  const input = good();
  const files = cliFiles(input);
  for (const drop of ["--required", "--sha", "--repo"]) {
    const args = goodArgs();
    const i = args.indexOf(drop);
    args.splice(i, 2);
    assert.equal(cli(args, files).status, 2, drop);
  }
  const empty = goodArgs();
  empty[empty.indexOf("--sha") + 1] = "";
  assert.equal(cli(empty, files).status, 2);
  assert.equal(cli(goodArgs(), { "--checks": input.checks, "--jobs": jobsFor(input.checks) }).status, 2, "missing --runs");
  assert.equal(cli(goodArgs(), { "--checks": input.checks, "--runs": input.runs }).status, 2, "missing --jobs");
});

test("CLI refuses when the job file is not JSON, is missing, or is not a regular file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt1471-pos-gate-"));
  const input = good();
  const checks = path.join(dir, "checks.json");
  const runs = path.join(dir, "runs.json");
  fs.writeFileSync(checks, JSON.stringify(input.checks));
  fs.writeFileSync(runs, JSON.stringify(input.runs));
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "not json");
  for (const jobsFile of [bad, path.join(dir, "missing.json"), dir]) {
    const res = spawnSync(process.execPath, [path.join(__dirname, "ci-check-gate.cjs"), ...goodArgs(), "--checks", checks, "--runs", runs, "--jobs", jobsFile], { encoding: "utf8" });
    assert.equal(res.status, 1, `${jobsFile}: ${res.stdout}${res.stderr}`);
  }
});

test("CLI refuses when the check or run file is not JSON, is missing, or is not a regular file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt1471-pos-gate-"));
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "not json");
  const input = good();
  const ok = path.join(dir, "ok.json");
  fs.writeFileSync(ok, JSON.stringify(input.runs));
  const checksOk = path.join(dir, "checks.json");
  fs.writeFileSync(checksOk, JSON.stringify(input.checks));
  const jobsOk = path.join(dir, "jobs.json");
  fs.writeFileSync(jobsOk, JSON.stringify(jobsFor(input.checks)));
  for (const [c, r] of [[bad, ok], [ok, bad], [path.join(dir, "missing.json"), ok], [checksOk, dir]]) {
    const res = spawnSync(process.execPath, [path.join(__dirname, "ci-check-gate.cjs"), ...goodArgs(), "--checks", c, "--runs", r, "--jobs", jobsOk], { encoding: "utf8" });
    assert.equal(res.status, 1, `${c} ${r}: ${res.stdout}${res.stderr}`);
  }
});

test("CLI refuses a required list that is not JSON", () => {
  const input = good();
  const args = goodArgs();
  args[args.indexOf("--required") + 1] = "{not json";
  const r = cli(args, cliFiles(input));
  assert.equal(r.status, 1, r.out);
});
