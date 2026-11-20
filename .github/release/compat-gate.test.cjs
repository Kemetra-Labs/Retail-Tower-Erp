// RT-871: spec for .github/release/compat-gate.cjs (the Backend-Core release guard).
// Run: node --test .github/release/
// contracts-compat's parser is replaced by a stub lib (JSON in, same exported names), so the
// spec covers the guard's decisions, not the product parser. Set COMPAT_GATE_REAL_LIB and
// COMPAT_GATE_REAL_SOURCE to also run the gate against a real Backend-Core tree.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const gate = require("./compat-gate.cjs");

const NOW = new Date("2026-10-25T12:00:00Z");
const REQUIRED = ["bc/fast", "bc/db-integration", "bc/db-package", gate.COMPAT_CHECK];
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const STUB_LIB = {
  "evaluate.mjs": `export const FRESHNESS_DAYS = 7;
export function validateStructure(m) {
  const p = [];
  if (!m || typeof m !== "object") return ["not a mapping"];
  if (!m.fleet_baseline || typeof m.fleet_baseline.captured_at !== "string") p.push("fleet_baseline.captured_at missing");
  if (!Array.isArray(m.supported)) p.push("supported missing");
  return p;
}
export function snapshotId(s) { return s.pin; }
`,
  "yaml-subset.mjs": "export function parseYamlSubset(t) { return JSON.parse(t); }\n",
  "replay.mjs": 'export const PROVENANCE = ["synthetic", "recorded"];\n',
};

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rt871-gate-"));
}

function stubLib() {
  const dir = tmpdir();
  for (const [f, text] of Object.entries(STUB_LIB)) fs.writeFileSync(path.join(dir, f), text);
  return dir;
}

/** A Backend-Core tree with contracts-compat/: matrix object, fixtures {id: [provenance, ...]}. */
function source({ capturedAt = "2026-10-24T00:00:00Z", supported = ["pos-a", "pos-b"], fixtures = {}, matrixText } = {}) {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "contracts-compat", "replay"), { recursive: true });
  const matrix = { fleet_baseline: { captured_at: capturedAt }, supported: supported.map((pin) => ({ pin })) };
  fs.writeFileSync(path.join(dir, "contracts-compat", "pos-supported.yaml"), matrixText ?? JSON.stringify(matrix));
  for (const [id, provs] of Object.entries(fixtures)) {
    fs.mkdirSync(path.join(dir, "contracts-compat", "replay", id));
    provs.forEach((p, i) => fs.writeFileSync(path.join(dir, "contracts-compat", "replay", id, `f${i}.yaml`), JSON.stringify({ provenance: p })));
  }
  return dir;
}

function runs(overrides = {}) {
  return REQUIRED.map((name) => ({ name, conclusion: "success", slug: "github-actions", started_at: "2026-10-25T10:00:00Z", head_sha: SHA, ...(overrides[name] ?? {}) }));
}

const lib = stubLib();

test("passes: all checks green, fresh fleet, replay NOT_PROVEN recorded but not blocking", () => {
  const r = gate.evaluateGuard({ runs: runs(), sha: SHA, required: REQUIRED, sourceDir: source(), libDir: lib, now: NOW });
  assert.equal(r.verdict, "PASS");
  assert.equal(r.mode, "pr+fleet");
  assert.match(r.notes.join("\n"), /NOT_PROVEN \(no recorded replay fixture for pos-a, pos-b\)/);
});

for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "neutral", null]) {
  test(`refuses: compat check run is ${conclusion ?? "still running"}`, () => {
    const r = gate.evaluateGuard({
      runs: runs({ [gate.COMPAT_CHECK]: { conclusion } }),
      sha: SHA,
      required: REQUIRED,
      sourceDir: source(),
      libDir: lib,
      now: NOW,
    });
    assert.equal(r.verdict, "REFUSED");
    assert.ok(r.problems.some((p) => p.includes(`'${gate.COMPAT_CHECK}' is '${conclusion ?? "pending"}'`)), r.problems.join("\n"));
  });
}

test("refuses: compat check run missing", () => {
  const r = gate.evaluateGuard({
    runs: runs().filter((x) => x.name !== gate.COMPAT_CHECK),
    sha: SHA,
    required: REQUIRED,
    sourceDir: source(),
    libDir: lib,
    now: NOW,
  });
  assert.equal(r.verdict, "REFUSED");
  assert.ok(r.problems.some((p) => p.includes(`'${gate.COMPAT_CHECK}' is 'missing'`)));
});

test("refuses: compat run green but from another app (not github-actions)", () => {
  const r = gate.judgeChecks(runs({ [gate.COMPAT_CHECK]: { slug: "some-bot" } }), REQUIRED, SHA);
  assert.ok(r.problems.some((p) => p.includes("'missing'")));
});

test("refuses: an older green run does not mask a newer red one", () => {
  const all = [...runs(), { name: gate.COMPAT_CHECK, conclusion: "failure", slug: "github-actions", started_at: "2026-10-25T11:00:00Z", head_sha: SHA }];
  assert.ok(gate.judgeChecks(all, REQUIRED, SHA).problems.some((p) => p.includes("'failure'")));
});

test("passes check half: a newer green re-run supersedes an older red one", () => {
  const all = [{ name: gate.COMPAT_CHECK, conclusion: "failure", slug: "github-actions", started_at: "2026-10-25T09:00:00Z", head_sha: SHA }, ...runs()];
  assert.deepEqual(gate.judgeChecks(all, REQUIRED, SHA).problems, []);
});

test("refuses: required list without the compat check (MR-3)", () => {
  const r = gate.judgeChecks(runs(), ["bc/fast"], SHA);
  assert.ok(r.problems.some((p) => p.includes("do not include")));
});

test("refuses: another required check red", () => {
  const r = gate.judgeChecks(runs({ "bc/db-package": { conclusion: "failure" } }), REQUIRED, SHA);
  assert.ok(r.problems.some((p) => p.includes("'bc/db-package' is 'failure'")));
});

test("refuses: unreadable check runs or empty required list", () => {
  assert.ok(gate.judgeChecks(null, REQUIRED, SHA).problems.length > 0);
  assert.ok(gate.judgeChecks(runs(), [], SHA).problems.length > 0);
});

test("refuses: contracts-compat/ absent from the release commit (Shadow today)", () => {
  const r = gate.evaluateGuard({ runs: runs(), sha: SHA, required: REQUIRED, sourceDir: tmpdir(), libDir: lib, now: NOW });
  assert.equal(r.verdict, "REFUSED");
  assert.ok(r.problems.some((p) => p.includes("pos-supported.yaml is missing")));
});

test("refuses: contracts-compat parser lib absent", () => {
  const r = gate.evaluateCompat(source(), tmpdir(), NOW);
  assert.equal(r.mode, null);
  assert.match(r.problems[0], /parser .* is missing/);
});

test("refuses: stale fleet baseline (FAIL_STALE_FLEET)", () => {
  const r = gate.evaluateCompat(source({ capturedAt: "2026-10-10T00:00:00Z" }), lib, NOW);
  assert.ok(r.problems.some((p) => p.includes("FAIL_STALE_FLEET")));
});

test("refuses: fleet baseline dated in the future", () => {
  const r = gate.evaluateCompat(source({ capturedAt: "2026-10-26T00:00:00Z" }), lib, NOW);
  assert.ok(r.problems.some((p) => p.includes("in the future")));
});

test("refuses: malformed matrix", () => {
  assert.equal(gate.evaluateCompat(source({ matrixText: "{not json" }), lib, NOW).mode, null);
  assert.equal(gate.evaluateCompat(source({ matrixText: "{}" }), lib, NOW).mode, null);
});

test("refuses: unknown fixture provenance is unreadable, not 'not recorded'", () => {
  const r = gate.evaluateCompat(source({ fixtures: { "pos-a": ["guessed"] } }), lib, NOW);
  assert.equal(r.mode, null);
  assert.match(r.problems[0], /unreadable/);
});

test("refuses: matrix reached through a symlink", () => {
  const dir = source();
  const m = path.join(dir, "contracts-compat", "pos-supported.yaml");
  const real = path.join(dir, "real.yaml");
  fs.renameSync(m, real);
  fs.symlinkSync(real, m);
  assert.equal(gate.evaluateCompat(dir, lib, NOW).mode, null);
});

test("switches to release mode once every supported snapshot has a recorded fixture", () => {
  const r = gate.evaluateCompat(source({ fixtures: { "pos-a": ["recorded"], "pos-b": ["synthetic", "recorded"] } }), lib, NOW);
  assert.equal(r.mode, "release");
  assert.deepEqual(r.problems, []);
});

test("CLI: exit 1 and REFUSED on a missing compat run, exit 0 on a full pass, exit 2 on bad usage", () => {
  const dir = tmpdir();
  const red = path.join(dir, "red.json");
  const green = path.join(dir, "green.json");
  fs.writeFileSync(red, JSON.stringify(runs().filter((x) => x.name !== gate.COMPAT_CHECK)));
  fs.writeFileSync(green, JSON.stringify(runs()));
  const cli = (checks) =>
    spawnSync(process.execPath, [path.join(__dirname, "compat-gate.cjs"), "--checks", checks, "--required", JSON.stringify(REQUIRED), "--sha", SHA, "--source", source(), "--lib", lib, "--now", NOW.toISOString()], { encoding: "utf8" });
  const refused = cli(red);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /POS compat gate: REFUSED/);
  const passed = cli(green);
  assert.equal(passed.status, 0, passed.stdout);
  assert.match(passed.stdout, /POS compat gate: PASS \(mode pr\+fleet\)/);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, "compat-gate.cjs"), "--checks"], { encoding: "utf8" }).status, 2);
});

test("refuses: a check run that reports another head SHA (wrong-SHA, fail closed)", () => {
  const r = gate.judgeChecks(runs({ "bc/fast": { head_sha: OTHER_SHA } }), REQUIRED, SHA);
  assert.ok(r.problems.some((p) => p.includes("'bc/fast'") && p.includes("not the release SHA")), r.problems.join("\n"));
});

test("refuses: a required check run with no head_sha at all", () => {
  const r = gate.judgeChecks(runs({ "bc/fast": { head_sha: undefined } }), REQUIRED, SHA);
  assert.ok(r.problems.some((p) => p.includes("'bc/fast'") && p.includes("not the release SHA")));
});

test("refuses: a wrong-SHA run is never read as the release SHA's green result", () => {
  const r = gate.judgeChecks(runs({ "bc/fast": { head_sha: OTHER_SHA, conclusion: "success" } }), REQUIRED, SHA);
  assert.ok(r.problems.length > 0);
});

test("a run of an unrelated check name on another SHA is ignored", () => {
  const all = [...runs(), { name: "gate/anything", conclusion: "failure", slug: "github-actions", started_at: "2026-10-25T11:00:00Z", head_sha: OTHER_SHA }];
  assert.deepEqual(gate.judgeChecks(all, REQUIRED, SHA).problems, []);
});

for (const bad of [undefined, "", "main", "A".repeat(40), "a".repeat(39)]) {
  test(`refuses: release SHA ${JSON.stringify(bad)} is not 40 lowercase hex`, () => {
    const r = gate.judgeChecks(runs(), REQUIRED, bad);
    assert.ok(r.problems.some((p) => p.includes("release SHA")));
  });
}

test("refuses: a check run list that is not an array of objects", () => {
  assert.ok(gate.judgeChecks({ check_runs: [] }, REQUIRED, SHA).problems.length > 0);
  assert.ok(gate.judgeChecks([null, 3, "x"], REQUIRED, SHA).problems.length > 0);
});

test("missing or pending checks: the refusal names the exact-SHA dispatch and dispatches nothing", () => {
  const r = gate.evaluateGuard({ runs: runs().filter((x) => x.name !== "bc/fast"), sha: SHA, required: REQUIRED, sourceDir: source(), libDir: lib, now: NOW });
  assert.equal(r.verdict, "REFUSED");
  const text = r.notes.join("\n");
  assert.ok(text.includes(`gh workflow run backend-core.yml --ref main -f expected_sha=${SHA}`), text);
  assert.match(text, /guard dispatches nothing/);
  const pending = gate.evaluateGuard({ runs: runs({ "bc/db-package": { conclusion: null } }), sha: SHA, required: REQUIRED, sourceDir: source(), libDir: lib, now: NOW });
  assert.match(pending.notes.join("\n"), /expected_sha=/);
});

test("red checks: no dispatch hint (a dispatch is not a way past a failed suite)", () => {
  const r = gate.evaluateGuard({ runs: runs({ "bc/fast": { conclusion: "failure" } }), sha: SHA, required: REQUIRED, sourceDir: source(), libDir: lib, now: NOW });
  assert.equal(r.verdict, "REFUSED");
  assert.doesNotMatch(r.notes.join("\n"), /expected_sha=/);
});

test("a passing guard prints no dispatch hint", () => {
  const r = gate.evaluateGuard({ runs: runs(), sha: SHA, required: REQUIRED, sourceDir: source(), libDir: lib, now: NOW });
  assert.equal(r.verdict, "PASS");
  assert.doesNotMatch(r.notes.join("\n"), /expected_sha=/);
});

test("CLI: exit 2 without --sha, exit 1 on a wrong-SHA run", () => {
  const dir = tmpdir();
  const wrong = path.join(dir, "wrong.json");
  fs.writeFileSync(wrong, JSON.stringify(runs({ "bc/fast": { head_sha: OTHER_SHA } })));
  const base = ["--checks", wrong, "--required", JSON.stringify(REQUIRED), "--source", source(), "--lib", lib, "--now", NOW.toISOString()];
  const run = (extra) => spawnSync(process.execPath, [path.join(__dirname, "compat-gate.cjs"), ...base, ...extra], { encoding: "utf8" });
  assert.equal(run([]).status, 2);
  assert.equal(run(["--sha", SHA]).status, 1);
});

test("refuses: two runs of one check with the same started_at, whatever the API order (tie fails closed)", () => {
  const green = { name: "bc/fast", conclusion: "success", slug: "github-actions", started_at: "2026-10-25T10:00:00Z", head_sha: SHA };
  const red = { ...green, conclusion: "failure" };
  for (const order of [[green, red], [red, green]]) {
    const r = gate.judgeChecks([...runs().filter((x) => x.name !== "bc/fast"), ...order], REQUIRED, SHA);
    assert.ok(r.problems.some((p) => p.includes("'bc/fast' is 'failure'")), r.problems.join("\n"));
  }
});

test("refuses: a run with no started_at is the newest, so a pending re-run is not masked by an older green", () => {
  const rerun = { name: "bc/fast", conclusion: null, slug: "github-actions", started_at: null, head_sha: SHA };
  const r = gate.judgeChecks([...runs(), rerun], REQUIRED, SHA);
  assert.ok(r.problems.some((p) => p.includes("'bc/fast' is 'pending'")), r.problems.join("\n"));
});

test("refuses: a correct green run does not mask a foreign-SHA run of the same check", () => {
  const all = [...runs(), { name: "bc/fast", conclusion: "success", slug: "github-actions", started_at: "2026-10-25T11:00:00Z", head_sha: OTHER_SHA }];
  const r = gate.judgeChecks(all, REQUIRED, SHA);
  assert.ok(r.problems.some((p) => p.includes("not the release SHA")));
});

test("an untrusted-app run with a wrong head_sha is ignored", () => {
  const all = [...runs(), { name: "bc/fast", conclusion: "failure", slug: "some-bot", started_at: "2026-10-25T11:00:00Z", head_sha: OTHER_SHA }];
  assert.deepEqual(gate.judgeChecks(all, REQUIRED, SHA).problems, []);
});

test("a release SHA with a trailing newline or 41 characters is refused", () => {
  assert.ok(gate.judgeChecks(runs(), REQUIRED, `${SHA}\n`).problems.some((p) => p.includes("release SHA")));
  assert.ok(gate.judgeChecks(runs(), REQUIRED, `${SHA}a`).problems.some((p) => p.includes("release SHA")));
});

test("mixed null and non-object entries do not crash and do not mask a missing check", () => {
  const r = gate.judgeChecks([null, 3, "x", ...runs().filter((x) => x.name !== "bc/fast")], REQUIRED, SHA);
  assert.ok(r.problems.some((p) => p.includes("'bc/fast' is 'missing'")));
});

test("no dispatch hint when a missing check sits beside a red one (a dispatch cannot clear the red)", () => {
  const r = gate.evaluateGuard({
    runs: runs({ "bc/db-package": { conclusion: "failure" } }).filter((x) => x.name !== "bc/fast"),
    sha: SHA,
    required: REQUIRED,
    sourceDir: source(),
    libDir: lib,
    now: NOW,
  });
  assert.equal(r.verdict, "REFUSED");
  assert.doesNotMatch(r.notes.join("\n"), /expected_sha=/);
});

test("no dispatch hint when the only cause is a foreign head SHA, and none for an invalid SHA", () => {
  const foreign = gate.evaluateGuard({ runs: runs({ "bc/fast": { head_sha: OTHER_SHA } }), sha: SHA, required: REQUIRED, sourceDir: source(), libDir: lib, now: NOW });
  assert.equal(foreign.verdict, "REFUSED");
  assert.doesNotMatch(foreign.notes.join("\n"), /expected_sha=/);
  const bad = gate.evaluateGuard({ runs: runs().filter((x) => x.name !== "bc/fast"), sha: "main", required: REQUIRED, sourceDir: source(), libDir: lib, now: NOW });
  assert.equal(bad.verdict, "REFUSED");
  assert.doesNotMatch(bad.notes.join("\n"), /expected_sha=/);
});

test("CLI: --sha with an empty value or followed by another flag is a usage error", () => {
  const dir = tmpdir();
  const ok = path.join(dir, "ok.json");
  fs.writeFileSync(ok, JSON.stringify(runs()));
  const base = ["--checks", ok, "--required", JSON.stringify(REQUIRED), "--source", source(), "--lib", lib];
  const run = (extra) => spawnSync(process.execPath, [path.join(__dirname, "compat-gate.cjs"), ...base, ...extra], { encoding: "utf8" });
  assert.equal(run(["--sha", ""]).status, 2);
  assert.equal(run(["--sha", "--now", NOW.toISOString()]).status, 2);
});

test("real Backend-Core contracts-compat (opt-in)", { skip: !process.env.COMPAT_GATE_REAL_LIB }, () => {
  const r = gate.evaluateCompat(process.env.COMPAT_GATE_REAL_SOURCE, process.env.COMPAT_GATE_REAL_LIB, new Date(process.env.COMPAT_GATE_REAL_NOW ?? Date.now()));
  console.log(JSON.stringify(r));
  assert.ok(r.mode === "pr+fleet" || r.mode === "release" || r.problems.length > 0);
});
