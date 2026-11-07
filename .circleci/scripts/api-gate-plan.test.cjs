// RT-1258: offline specs for the plan the split API gate judges (api-gate-plan.cjs): when an IMPACTED
// plan is acceptable, and that every doubt is FULL. No CircleCI run is needed for any of these.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const p = require("./api-gate-plan.cjs");

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const ALL = ["test/a.spec.ts", "test/b.spec.ts", "test/c.spec.ts", "test/d.spec.ts"];
const MUST = "test/tooling/changelog-fragments.spec.ts";
const DISCOVERED = [...ALL, MUST];
const plan = (over = {}) => ({
  mode: "IMPACTED",
  sha: SHA,
  guard: { decision: "TIA_ELIGIBLE", head: SHA },
  mustRun: [MUST],
  atoms: ["test/a.spec.ts", MUST],
  ...over,
});
const guard = (over = {}) => ({
  decision: "TIA_ELIGIBLE",
  head: SHA,
  changed: [`${p.API_PREFIX}test/a.spec.ts`, `${p.API_PREFIX}src/a.ts`, "services/backend-core/changelog.d/RT-1-x.md"],
  mustRun: [MUST],
  ...over,
});

test("a consistent IMPACTED plan for this commit has no structural problem", () => {
  assert.deepEqual(p.planProblems(plan(), SHA, DISCOVERED), []);
});

test("structural problems: every one keeps the run FULL", () => {
  const probs = (over, head = SHA, disc = DISCOVERED) => p.planProblems(plan(over), head, disc).join("; ");
  assert.match(probs({ mode: "FULL" }), /not IMPACTED/);
  assert.match(probs({ sha: OTHER }), /plan is for b+, not a+/);
  assert.match(probs({}, OTHER), /plan is for a+, not b+/);
  assert.match(probs({}, "short"), /head sha missing or malformed/);
  assert.match(probs({ guard: { decision: "FORCE_FULL", head: SHA } }), /guard decision is FORCE_FULL/);
  assert.match(probs({ guard: { decision: "TIA_ELIGIBLE", head: OTHER } }), /guard ran on b+/);
  assert.match(probs({ guard: undefined }), /guard decision is missing/);
  assert.match(probs({ atoms: [] }), /missing, not strings, or empty/);
  assert.match(probs({ atoms: "test/a.spec.ts" }), /missing, not strings, or empty/);
  assert.match(probs({ atoms: [1, 2] }), /missing, not strings, or empty/);
  assert.match(probs({ atoms: ["test/a.spec.ts", "test/a.spec.ts", MUST] }), /lists a spec twice/);
  assert.match(probs({ atoms: ["../etc/x.spec.ts", MUST] }), /unexpected shape/);
  assert.match(probs({ atoms: ["--runInBand.spec.ts", MUST] }), /unexpected shape/);
  assert.match(probs({ atoms: ["test/a.spec.ts", "test/zzz.spec.ts", MUST] }), /1 planned spec\(s\) are not discovered, first: test\/zzz\.spec\.ts/);
  assert.match(probs({ atoms: [...DISCOVERED] }), /nothing is skipped/);
  assert.match(probs({ atoms: ["test/a.spec.ts"] }), /must-run spec\(s\) not planned: .*changelog-fragments/);
  assert.match(probs({ mustRun: undefined }), /must-run list is missing/);
  assert.match(probs({}, SHA, []), /no discovered spec list/);
  assert.deepEqual(p.planProblems(null, SHA, DISCOVERED), ["plan is not an object"]);
});

test("independent guard: it must agree, and every changed spec and must-run spec must be planned", () => {
  assert.deepEqual(p.independentProblems(plan(), guard(), SHA), []);
  const probs = (g, pl = plan()) => p.independentProblems(pl, g, SHA).join("; ");
  assert.match(probs(null), /no independent risk guard result/);
  assert.match(probs(guard({ decision: "FORCE_FULL", reason: "2 change(s) force the full suite" })), /says FORCE_FULL: 2 change/);
  assert.match(probs(guard({ head: OTHER })), /ran on b+, not a+/);
  assert.match(probs(guard({ changed: undefined })), /changed-path or must-run list is missing/);
  assert.match(
    probs(guard({ changed: [`${p.API_PREFIX}test/z.spec.ts`] })),
    /changed spec\(s\) not in the plan: test\/z\.spec\.ts/,
  );
  assert.match(probs(guard({ mustRun: [MUST, "test/other.spec.ts"] })), /guard must-run spec\(s\) not in the plan: test\/other\.spec\.ts/);
  assert.match(probs(guard({ mustRun: [] })), /must-run list differs/);
  // A changed non-spec file or a spec outside apps/api is not a changed spec.
  assert.deepEqual(p.independentProblems(plan(), guard({ changed: [`${p.API_PREFIX}src/b.ts`, "apps/pos/x.spec.ts"] }), SHA), []);
});

function ws(planObj, discovered = DISCOVERED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt1258-plan-"));
  const planFile = path.join(dir, "plan.json");
  if (planObj !== undefined) fs.writeFileSync(planFile, typeof planObj === "string" ? planObj : JSON.stringify(planObj));
  const disc = path.join(dir, "discovered.txt");
  if (discovered) fs.writeFileSync(disc, `${discovered.join("\n")}\n`);
  return { dir, planFile, disc, out: path.join(dir, "atoms.txt") };
}

test("select: IMPACTED only for a valid plan; a missing, FULL, stale or unreadable plan is FULL", () => {
  const log = console.log;
  const err = console.error;
  const shown = [];
  console.log = (s) => shown.push(s);
  console.error = () => {};
  const dirs = [];
  try {
    const run = (w, head = SHA) => {
      dirs.push(w.dir);
      shown.length = 0;
      assert.equal(p.main(["select", w.planFile, w.disc, head, w.out]), 0);
      return shown[0];
    };
    const ok = ws(plan());
    assert.equal(run(ok), "IMPACTED");
    assert.deepEqual(fs.readFileSync(ok.out, "utf8").trim().split("\n"), ["test/a.spec.ts", MUST]);
    for (const [name, w, head] of [
      ["no plan file", ws(undefined)],
      ["FULL plan", ws({ mode: "FULL", reasons: ["x"], atoms: [] })],
      ["unreadable", ws("{not json")],
      ["stale sha", ws(plan({ sha: OTHER }))],
      ["wrong head", ws(plan()), OTHER],
      ["no discovered list", ws(plan(), null)],
      ["covers everything", ws(plan({ atoms: [...DISCOVERED] }))],
    ]) {
      assert.equal(run(w, head), "FULL", name);
      assert.equal(fs.existsSync(w.out), false, `${name}: no atoms file`);
    }
    assert.equal(p.main(["bogus"]), 0);
    assert.equal(shown.at(-1), "FULL");
  } finally {
    console.log = log;
    console.error = err;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});
