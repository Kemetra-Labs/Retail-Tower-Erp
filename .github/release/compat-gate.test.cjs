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
  return REQUIRED.map((name) => ({ name, conclusion: "success", slug: "github-actions", started_at: "2026-10-25T10:00:00Z", ...(overrides[name] ?? {}) }));
}

const lib = stubLib();

test("passes: all checks green, fresh fleet, replay NOT_PROVEN recorded but not blocking", () => {
  const r = gate.evaluateGuard({ runs: runs(), required: REQUIRED, sourceDir: source(), libDir: lib, now: NOW });
  assert.equal(r.verdict, "PASS");
  assert.equal(r.mode, "pr+fleet");
  assert.match(r.notes.join("\n"), /NOT_PROVEN \(no recorded replay fixture for pos-a, pos-b\)/);
});

for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "neutral", null]) {
  test(`refuses: compat check run is ${conclusion ?? "still running"}`, () => {
    const r = gate.evaluateGuard({
      runs: runs({ [gate.COMPAT_CHECK]: { conclusion } }),
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
    required: REQUIRED,
    sourceDir: source(),
    libDir: lib,
    now: NOW,
  });
  assert.equal(r.verdict, "REFUSED");
  assert.ok(r.problems.some((p) => p.includes(`'${gate.COMPAT_CHECK}' is 'missing'`)));
});

test("refuses: compat run green but from another app (not github-actions)", () => {
  const r = gate.judgeChecks(runs({ [gate.COMPAT_CHECK]: { slug: "some-bot" } }), REQUIRED);
  assert.ok(r.problems.some((p) => p.includes("'missing'")));
});

test("refuses: an older green run does not mask a newer red one", () => {
  const all = [...runs(), { name: gate.COMPAT_CHECK, conclusion: "failure", slug: "github-actions", started_at: "2026-10-25T11:00:00Z" }];
  assert.ok(gate.judgeChecks(all, REQUIRED).problems.some((p) => p.includes("'failure'")));
});

test("passes check half: a newer green re-run supersedes an older red one", () => {
  const all = [{ name: gate.COMPAT_CHECK, conclusion: "failure", slug: "github-actions", started_at: "2026-10-25T09:00:00Z" }, ...runs()];
  assert.deepEqual(gate.judgeChecks(all, REQUIRED).problems, []);
});

test("refuses: required list without the compat check (MR-3)", () => {
  const r = gate.judgeChecks(runs(), ["bc/fast"]);
  assert.ok(r.problems.some((p) => p.includes("do not include")));
});

test("refuses: another required check red", () => {
  const r = gate.judgeChecks(runs({ "bc/db-package": { conclusion: "failure" } }), REQUIRED);
  assert.ok(r.problems.some((p) => p.includes("'bc/db-package' is 'failure'")));
});

test("refuses: unreadable check runs or empty required list", () => {
  assert.ok(gate.judgeChecks(null, REQUIRED).problems.length > 0);
  assert.ok(gate.judgeChecks(runs(), []).problems.length > 0);
});

test("refuses: contracts-compat/ absent from the release commit (Shadow today)", () => {
  const r = gate.evaluateGuard({ runs: runs(), required: REQUIRED, sourceDir: tmpdir(), libDir: lib, now: NOW });
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
    spawnSync(process.execPath, [path.join(__dirname, "compat-gate.cjs"), "--checks", checks, "--required", JSON.stringify(REQUIRED), "--source", source(), "--lib", lib, "--now", NOW.toISOString()], { encoding: "utf8" });
  const refused = cli(red);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /POS compat gate: REFUSED/);
  const passed = cli(green);
  assert.equal(passed.status, 0, passed.stdout);
  assert.match(passed.stdout, /POS compat gate: PASS \(mode pr\+fleet\)/);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, "compat-gate.cjs"), "--checks"], { encoding: "utf8" }).status, 2);
});

test("real Backend-Core contracts-compat (opt-in)", { skip: !process.env.COMPAT_GATE_REAL_LIB }, () => {
  const r = gate.evaluateCompat(process.env.COMPAT_GATE_REAL_SOURCE, process.env.COMPAT_GATE_REAL_LIB, new Date(process.env.COMPAT_GATE_REAL_NOW ?? Date.now()));
  console.log(JSON.stringify(r));
  assert.ok(r.mode === "pr+fleet" || r.mode === "release" || r.problems.length > 0);
});
