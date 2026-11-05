#!/usr/bin/env node
// RT-1075: offline tests for tia-risk-guard.cjs. `node --test .circleci/scripts/` runs them; no
// network and no CircleCI. The git cases build a throwaway origin (bare) and clone in the OS temp
// dir, with the global and system git config switched off so signing and hooks never apply.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const guard = require("./tia-risk-guard.cjs");

const { FORCE_FULL, TIA_ELIGIBLE } = guard;
const ROOT = path.resolve(__dirname, "..", "..");

const emptyGitConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rt1075-cfg-")), "gitconfig");
fs.writeFileSync(emptyGitConfig, "");
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rt1075",
  GIT_AUTHOR_EMAIL: "rt1075@example.invalid",
  GIT_COMMITTER_NAME: "rt1075",
  GIT_COMMITTER_EMAIL: "rt1075@example.invalid",
});

const OPENAPI = "services/backend-core/packages/contracts/openapi/";
const PR221_OPENAPI = [`${OPENAPI}a.yaml`, `${OPENAPI}b.yaml`, `${OPENAPI}sub/c.yaml`, `${OPENAPI}sub/d.yaml`];
const SRC = "services/backend-core/apps/api/src/";
const TEST = "services/backend-core/apps/api/test/";
// A repo file as LF text (a Windows checkout may have CRLF).
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// ---- pure classification -------------------------------------------------------------------

test("PR #221 shape: four OpenAPI files force FULL, also beside unrelated source changes", () => {
  assert.equal(guard.classify(PR221_OPENAPI).decision, FORCE_FULL);
  const r = guard.classify([...PR221_OPENAPI, `${SRC}catalog/products/products.service.ts`]);
  assert.equal(r.decision, FORCE_FULL);
  assert.deepEqual(r.forcing.map((f) => f.path), PR221_OPENAPI);
});

test("only ordinary API source and specs: TIA_ELIGIBLE (decision only)", () => {
  const r = guard.classify([`${SRC}catalog/products/products.service.ts`, `${TEST}catalog/products.spec.ts`, `${SRC}health/x.test.ts`]);
  assert.equal(r.decision, TIA_ELIGIBLE);
  assert.deepEqual(r.forcing, []);
});

test("critical Backend-Core tiers under apps/api force FULL", () => {
  for (const p of [
    `${SRC}auth/guard.ts`,
    `${SRC}settlement/x.ts`,
    `${SRC}openapi/doc.ts`,
    `${SRC}inventory/a/b.ts`,
    `${SRC}pos-shifts/x.ts`,
    `${SRC}tenants/x.ts`,
    `${SRC}catalog/sales/x.ts`,
    `${SRC}catalog/erpnext-bin-view/x.ts`,
    `${SRC}catalog/erpnext-anything/x.ts`,
    `${SRC}connector-health/x.ts`,
    `${TEST}authz/x.spec.ts`,
    `${TEST}openapi/x.spec.ts`,
    `${TEST}contract-conformance.spec.ts`,
  ]) {
    assert.equal(guard.pathRisk(p), "critical Backend-Core tier", p);
  }
});

test("high-risk and unknown paths force FULL, at any depth", () => {
  for (const p of [
    ".nvmrc",
    ".circleci/config.yml",
    ".circleci/test-suites.yml",
    ".circleci/scripts/new-script.cjs",
    ".github/workflows/backend-core.yml",
    "package.json",
    "tools/project-graph/graph.yaml",
    "docs/x.md",
    "services/backend-core/package.json",
    "services/backend-core/pnpm-lock.yaml",
    "services/backend-core/tsconfig.base.json",
    "services/backend-core/apps/api/jest.config.cjs",
    "services/backend-core/apps/api/tsconfig.json",
    `${TEST}_helpers/db.ts`,
    `${TEST}_helpers/a/b/c/d.ts`,
    `${TEST}fixtures/data.json`,
    `${SRC}catalog/data.json`,
    `${OPENAPI}a/b/c/d/e/f/deep.yaml`,
    "services/backend-core/packages/brand-new-pkg/src/a/b/c/d/e.ts",
    "services/backend-core/packages/db/drizzle/meta/x/y.json",
    "services/backend-core/deploy/a/b/c/d/e.sh",
    "services/backend-core/docs/operations/sql/a.sql",
    "services/backend-core/Caddyfile",
    "services/backend-core/apps/worker/src/x.ts",
    "services/backend-core/new-top-folder/x.ts",
    "apps/pos/src/x.ts",
  ]) {
    assert.ok(guard.pathRisk(p), p);
    assert.equal(guard.classify([p]).decision, FORCE_FULL, p);
  }
});

test("unclassifiable paths and an empty diff force FULL", () => {
  for (const p of ["", "/etc/passwd", `${SRC}../src/x.ts`, `${SRC}./x.ts`, `${SRC}a//x.ts`, `${SRC}a\\x.ts`]) {
    assert.equal(guard.pathRisk(p), "unclassifiable path", JSON.stringify(p));
  }
  assert.equal(guard.classify([]).decision, FORCE_FULL);
  assert.equal(guard.classify(undefined).decision, FORCE_FULL);
});

test("the API fast class matches graph.yaml's api_jest_fast exactly", () => {
  for (const p of [`${SRC}x.ts`, `${SRC}v2028/rt0089.ts`, `${SRC}a/b/c/x.ts`, `${SRC}health/x.test.ts`, `${TEST}x.spec.ts`, `${TEST}a/b/x.spec.ts`]) {
    assert.equal(guard.pathRisk(p), null, p);
  }
  for (const p of [`${SRC}main.ts`, `${SRC}types/x.d.ts`, `${TEST}a/x.d.ts`, `${TEST}a/x.test.ts`, `${TEST}x.ts`, `${TEST}_helpers/x.spec.ts`, `${SRC}x.tsx`]) {
    assert.equal(guard.pathRisk(p), "outside the API fast class", p);
  }
});

test("deletes, type changes and special file modes force FULL; 100755 is regular", () => {
  const p = `${SRC}catalog/other.ts`;
  assert.equal(guard.changeRisk({ status: "M", mode: "100755", path: p }), null);
  assert.equal(guard.changeRisk({ status: "A", mode: "100644", path: p }), null);
  assert.match(guard.changeRisk({ status: "D", mode: "100644", path: p }), /deleted/);
  assert.match(guard.changeRisk({ status: "T", mode: "120000", path: p }), /git status T/);
  assert.match(guard.changeRisk({ status: "A", mode: "120000", path: p }), /special file mode/);
  assert.match(guard.changeRisk({ status: "A", mode: "160000", path: p }), /special file mode/);
  assert.equal(guard.classify([{ status: "D", mode: "100644", path: p }]).decision, FORCE_FULL);
});

test("git --raw -z parsing: ordinary records, and malformed or rename records throw", () => {
  const z = "0".repeat(40);
  const s = "a".repeat(40);
  assert.deepEqual(guard.parseRawZ(`:100644 100644 ${s} ${s} M\0a b.ts\0:100644 000000 ${s} ${z} D\0c\0:000000 100755 ${z} ${s} A\0d\0`), [
    { status: "M", mode: "100644", path: "a b.ts" },
    { status: "D", mode: "100644", path: "c" },
    { status: "A", mode: "100755", path: "d" },
  ]);
  assert.deepEqual(guard.parseRawZ(""), []);
  assert.throws(() => guard.parseRawZ(`:100644 100644 ${s} ${s} M\0a\0:100644`));
  assert.throws(() => guard.parseRawZ(`:100644 100644 ${s} ${s} R100\0old\0new\0`));
  assert.throws(() => guard.parseRawZ("M\0a\0"));
});

test("globToRegExp follows the graph syntax", () => {
  const re = guard.globToRegExp("a/{b,c-*}/**");
  assert.ok(re.test("a/b/x/y"));
  assert.ok(re.test("a/c-z/x"));
  assert.ok(!re.test("a/d/x"));
  assert.ok(!guard.globToRegExp("a/*.ts").test("a/b/c.ts"));
  assert.ok(guard.globToRegExp("a/**/*.ts").test("a/c.ts"));
  assert.ok(guard.globToRegExp("a/**/*.ts").test("a/b/c/d.ts"));
  assert.ok(guard.globToRegExp("a/?.ts").test("a/b.ts"));
  assert.ok(!guard.globToRegExp("a/?.ts").test("a/bc.ts"));
  assert.ok(guard.globToRegExp("a/**").test("a/b\nc"), "dotAll, as pgraph's re.DOTALL");
});

test("line terminators, control characters and lossy (U+FFFD) names force FULL, even in a critical tier", () => {
  for (const p of [`${SRC}auth/evil\nname.ts`, `${SRC}auth/evil\rname.ts`, `${SRC}settlement/a\u2028b.ts`, `${SRC}inventory/a\u2029b.ts`, `${SRC}x\u0001.ts`, `${SRC}x\u007f.ts`, `${SRC}x\uFFFD.ts`, `${SRC}auth/x\uFFFD.ts`]) {
    assert.ok(guard.pathRisk(p), JSON.stringify(p));
    assert.equal(guard.classify([p]).decision, FORCE_FULL, JSON.stringify(p));
  }
});

// ---- drift and config invariants ----------------------------------------------------------

// The items of a flow list such as `["a/{b,c}/**", d]`: split on commas outside braces, unquote.
function flowList(text) {
  const items = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  items.push(cur);
  return items.map((s) => s.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2")).filter(Boolean);
}

// Flow-list items of every `globs:` key in a block. Fails if any `globs:` key is not a one-line
// flow list (a block list, say), so a glob can never be skipped silently.
function globLists(block, what) {
  const keys = block.match(/^ +globs:/gm) || [];
  const flows = [...block.matchAll(/^ +globs: \[(.*)\][ \t]*(?:#.*)?$/gm)];
  assert.equal(flows.length, keys.length, `${what}: a globs key is not a one-line flow list`);
  return flows.flatMap((m) => flowList(m[1]));
}

// backend-core's tier globs and its api_jest_fast class, read from graph.yaml.
function graphBackendCore() {
  const graph = readText("tools/project-graph/graph.yaml");
  const start = graph.indexOf("\n  backend-core:\n");
  const tiersAt = graph.indexOf("\n    tiers:\n", start);
  const fastAt = graph.indexOf("\n    api_jest_fast:\n", tiersAt);
  assert.ok(start >= 0 && tiersAt > start && fastAt > tiersAt, "backend-core tiers / api_jest_fast not found in graph.yaml");
  const tierGlobs = globLists(graph.slice(tiersAt, fastAt), "backend-core tiers");
  const fastBlock = /^ +globs: \[(.*)\][ \t]*(?:#.*)?\n +exclude: \[(.*)\][ \t]*(?:#.*)?$/m.exec(graph.slice(fastAt, fastAt + 400));
  assert.ok(fastBlock, "api_jest_fast globs/exclude not found in graph.yaml");
  return { tierGlobs, fastGlobs: flowList(fastBlock[1]), fastExcludes: flowList(fastBlock[2]) };
}

// Whole segments of a glob before its first wildcard segment ("" if the first one has one).
const literalPrefix = (g) => {
  const segs = [];
  for (const s of g.split("/")) {
    if (/[*?{}]/.test(s)) break;
    segs.push(s);
  }
  return segs.join("/");
};

test("FAST_GLOBS and FAST_EXCLUDES equal graph.yaml's api_jest_fast", () => {
  const g = graphBackendCore();
  assert.deepEqual(guard.FAST_GLOBS, g.fastGlobs);
  assert.deepEqual(guard.FAST_EXCLUDES, g.fastExcludes);
});

test("CRITICAL_API_GLOBS mirrors every backend-core tier glob that can reach apps/api", () => {
  const { tierGlobs } = graphBackendCore();
  assert.ok(tierGlobs.length >= 40, `only ${tierGlobs.length} tier globs parsed`);
  const api = tierGlobs.filter((g) => g.startsWith("apps/api/"));
  assert.deepEqual([...api].sort(), [...guard.CRITICAL_API_GLOBS].sort());
  // Any other glob whose literal prefix could still reach apps/api (wildcard first, or `apps/*/…`,
  // `apps/{api,worker}/…`) must match no fast-class probe, or it has to be mirrored above.
  const probes = [
    "apps/api/src/x.ts", "apps/api/src/a/b/c/d/x.ts", "apps/api/src/auth/x.ts", "apps/api/src/money/a/x.ts",
    "apps/api/src/settlement/a/b/x.ts", "apps/api/test/x.spec.ts", "apps/api/test/a/b/c/x.spec.ts", "apps/api/test/auth/x.spec.ts",
  ];
  let probed = 0;
  for (const g of tierGlobs.filter((x) => !x.startsWith("apps/api/"))) {
    const pre = literalPrefix(g);
    if (pre !== "" && !"apps/api".startsWith(pre) && !pre.startsWith("apps/api")) continue;
    probed++;
    for (const p of probes) assert.ok(!guard.globToRegExp(g).test(p), `tier glob ${g} matches ${p}`);
  }
  assert.ok(probed >= 1, "no wildcard-prefixed tier glob probed (parser regression?)");
});

test("the drift parser rejects the YAML forms it cannot read", () => {
  assert.throws(() => globLists("    tiers:\n      a:\n        globs:\n          - apps/api/src/x/**\n", "t"));
  assert.deepEqual(globLists("        globs: ['apps/api/src/{a,b}/**', \"c\"]  # note\n", "t"), ["apps/api/src/{a,b}/**", "c"]);
  assert.equal(literalPrefix("apps/{api,worker}/src/**"), "apps");
  assert.equal(literalPrefix("*/*/package.json"), "");
});

// The pipeline-parameter defaults are review-time policy (RT-1059 pause), not a property of the
// guard: the job's self-test sets TIA_GUARD_RUNTIME=1 and skips this one, so re-enabling advisory
// by default (the documented rollback) cannot turn every guard decision into a self-test failure.
test(
  "config.yml keeps advisory paused and the manual routes off by default (review time only)",
  { skip: process.env.TIA_GUARD_RUNTIME === "1" && "policy check; runs offline, not in the CI self-test" },
  () => {
    const cfg = readText(".circleci/config.yml");
    const param = (name) => new RegExp(`\\n  ${name}:\\n(?:    [^\\n]*\\n)*?    default: ([^\\n]+)\\n`).exec(cfg)?.[1];
    assert.equal(param("advisory_enabled"), "false");
    assert.equal(param("full_tia_analysis"), "false");
    assert.equal(param("tia_probe"), "false");
    assert.equal(param("remote_suite"), "none");
  },
);

test("config.yml runs the full suite in both decisions and runs the guard", () => {
  const cfg = readText(".circleci/config.yml");
  assert.match(cfg, /circleci testsuite run "backend api jest" --run-tests=all --analyze-tests=none/);
  assert.doesNotMatch(cfg, /--run-tests=impacted/);
  assert.match(cfg, /node \.circleci\/scripts\/tia-risk-guard\.cjs/);
  assert.match(cfg, /TIA_GUARD_RUNTIME=1 timeout 120 node --test \.circleci\/scripts\/tia-risk-guard\.test\.cjs/);
});

// ---- git integration ----------------------------------------------------------------------

function sh(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(repo, rel, content) {
  const f = path.join(repo, ...rel.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

function commitAll(repo, msg) {
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", msg);
}

const SEED = [...PR221_OPENAPI, `${SRC}catalog/products/products.service.ts`, `${SRC}catalog/other.ts`, `${TEST}catalog/products.spec.ts`, "services/backend-core/packages/shared/src/index.ts"];

// origin (bare) with SEED on main, and a clone on branch `feature`.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt1075-"));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  sh(work, "remote", "add", "origin", origin);
  for (const p of SEED) write(work, p, `seed ${p}\n`);
  commitAll(work, "seed");
  sh(work, "push", "-q", "origin", "main");
  sh(work, "checkout", "-q", "-b", "feature");
  return { dir, origin, work };
}

test("PR #221 reproduction: FORCE_FULL on the first head and after unrelated corrective commits", () => {
  const { work } = makeRepo();
  for (const p of PR221_OPENAPI) write(work, p, `changed ${p}\n`);
  commitAll(work, "contracts change");
  let r = guard.evaluate(work, "feature");
  assert.equal(r.decision, FORCE_FULL);
  assert.deepEqual(r.forcing.map((f) => f.path).sort(), [...PR221_OPENAPI].sort());
  for (let i = 1; i <= 3; i++) {
    write(work, `${SRC}catalog/other.ts`, `corrective ${i}\n`);
    commitAll(work, `corrective ${i}`);
    r = guard.evaluate(work, "feature");
    assert.equal(r.decision, FORCE_FULL, `corrective head ${i}`);
    assert.deepEqual(r.forcing.map((f) => f.path).sort(), [...PR221_OPENAPI].sort());
    assert.ok(r.changed.includes(`${SRC}catalog/other.ts`));
  }
});

test("a PR with only ordinary API changes is TIA_ELIGIBLE; main's own later changes are not counted", () => {
  const { work } = makeRepo();
  write(work, `${SRC}catalog/other.ts`, "feature change\n");
  write(work, `${TEST}catalog/new.spec.ts`, "new spec\n");
  commitAll(work, "feature");
  // main moves on with a high-risk change after the branch point (triple-dot semantics).
  sh(work, "checkout", "-q", "main");
  write(work, PR221_OPENAPI[0], "main-only change\n");
  commitAll(work, "main moves");
  sh(work, "push", "-q", "origin", "main");
  sh(work, "checkout", "-q", "feature");
  const r = guard.evaluate(work, "feature");
  assert.equal(r.decision, TIA_ELIGIBLE, r.reason);
  assert.deepEqual([...r.changed].sort(), [`${SRC}catalog/other.ts`, `${TEST}catalog/new.spec.ts`]);
});

test("renamed, deleted and newly nested paths force FULL (deletes and renames of API source too)", () => {
  const cases = {
    rename: (w) => sh(w, "mv", PR221_OPENAPI[0], `${OPENAPI}renamed.yaml`),
    renameOut: (w) => sh(w, "mv", PR221_OPENAPI[0], `${SRC}catalog/moved.ts`),
    delete: (w) => sh(w, "rm", "-q", "services/backend-core/packages/shared/src/index.ts"),
    deleteApiSource: (w) => sh(w, "rm", "-q", `${SRC}catalog/other.ts`),
    renameApiSource: (w) => sh(w, "mv", `${SRC}catalog/other.ts`, `${SRC}catalog/renamed.ts`),
    nested: (w) => write(w, "services/backend-core/packages/shared/src/a/b/c/d/e/new.ts", "x\n"),
  };
  for (const [name, change] of Object.entries(cases)) {
    const { work } = makeRepo();
    change(work);
    commitAll(work, name);
    const r = guard.evaluate(work, "feature");
    assert.equal(r.decision, FORCE_FULL, name);
    if (name === "rename" || name === "renameOut") assert.ok(r.changed.includes(PR221_OPENAPI[0]), `${name}: old side of the rename`);
    if (name === "renameApiSource") assert.ok(r.changed.includes(`${SRC}catalog/renamed.ts`), `${name}: new side of the rename`);
  }
});

test("spaces and special characters in filenames are read exactly", () => {
  const { work } = makeRepo();
  // No `"`, `*` or `:`: Windows cannot create them, and the test runs there too.
  const odd = `${SRC}my dir/ä 'b'; $x.ts`;
  write(work, odd, "x\n");
  commitAll(work, "odd name");
  let r = guard.evaluate(work, "feature");
  assert.equal(r.decision, TIA_ELIGIBLE, r.reason);
  assert.deepEqual(r.changed, [odd]);
  const oddRisk = `${OPENAPI}with space/ü.yaml`;
  write(work, oddRisk, "x\n");
  commitAll(work, "odd high-risk name");
  r = guard.evaluate(work, "feature");
  assert.equal(r.decision, FORCE_FULL);
  assert.deepEqual(r.forcing.map((f) => f.path), [oddRisk]);
});

test("main push, unknown branch, failed fetch, no merge-base and a non-repo force FULL", () => {
  const { dir, work } = makeRepo();
  write(work, `${SRC}catalog/other.ts`, "eligible change\n");
  commitAll(work, "eligible");
  assert.equal(guard.evaluate(work, "feature").decision, TIA_ELIGIBLE);
  assert.match(guard.evaluate(work, "main").reason, /push to main/);
  assert.match(guard.evaluate(work, "").reason, /unknown branch/);
  assert.match(guard.evaluate(work, undefined).reason, /unknown branch/);

  sh(work, "remote", "set-url", "origin", path.join(dir, "missing.git"));
  const fetchFail = guard.evaluate(work, "feature");
  assert.equal(fetchFail.decision, FORCE_FULL);
  assert.match(fetchFail.reason, /could not fetch origin\/main/);

  // origin/main with no history in common with HEAD.
  const other = path.join(dir, "other");
  execFileSync("git", ["init", "-q", "-b", "main", other]);
  write(other, "unrelated.txt", "x\n");
  commitAll(other, "unrelated");
  const otherBare = path.join(dir, "other.git");
  execFileSync("git", ["clone", "-q", "--bare", other, otherBare]);
  sh(work, "remote", "set-url", "origin", otherBare);
  const noBase = guard.evaluate(work, "feature");
  assert.equal(noBase.decision, FORCE_FULL);
  assert.match(noBase.reason, /no merge-base/);

  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "rt1075-norepo-"));
  assert.equal(guard.evaluate(notRepo, "feature").decision, FORCE_FULL);
});

test("an empty PR diff forces FULL", () => {
  const { work } = makeRepo();
  const r = guard.evaluate(work, "feature");
  assert.equal(r.decision, FORCE_FULL);
  assert.match(r.reason, /empty/);
});

test("main() writes guard.json and guard.txt, and never throws", () => {
  const { work } = makeRepo();
  for (const p of PR221_OPENAPI) write(work, p, "changed\n");
  commitAll(work, "contracts");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rt1075-out-"));
  const log = console.log;
  console.log = () => {};
  let r;
  try {
    r = guard.main(["--repo", work, "--out", out], { CIRCLE_BRANCH: "feature" });
  } finally {
    console.log = log;
  }
  assert.equal(r.decision, FORCE_FULL);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "guard.json"), "utf8")).decision, FORCE_FULL);
  assert.match(fs.readFileSync(path.join(out, "guard.txt"), "utf8"), /^TIA_GUARD_DECISION=FORCE_FULL$/m);

  console.log = () => {};
  try {
    const bad = guard.main(["--repo", path.join(out, "nope"), "--out", path.join(out, "guard.json", "x")], { CIRCLE_BRANCH: "feature" });
    assert.equal(bad.decision, FORCE_FULL);
  } finally {
    console.log = log;
  }
});

// ---- RT-920: changelog fragments are neutral ----------------------------------------------------

const FRAG = "services/backend-core/changelog.d/";

test("a changelog fragment beside ordinary API changes is neutral: TIA_ELIGIBLE with the fragments spec as must-run", () => {
  const r = guard.classify([`${SRC}x.ts`, `${FRAG}RT-1-changed.md`]);
  assert.equal(r.decision, TIA_ELIGIBLE);
  assert.deepEqual(r.forcing, []);
  assert.deepEqual(r.neutral, [`${FRAG}RT-1-changed.md`]);
  assert.deepEqual(r.mustRun, ["test/tooling/changelog-fragments.spec.ts"]);
  assert.match(r.reason, /1 neutral file/);
});

test("ordinary API changes alone carry no must-run spec", () => {
  const r = guard.classify([`${SRC}x.ts`]);
  assert.equal(r.decision, TIA_ELIGIBLE);
  assert.deepEqual(r.neutral, []);
  assert.deepEqual(r.mustRun, []);
});

test("only changelog fragments: FORCE_FULL (no API change to measure)", () => {
  const r = guard.classify([`${FRAG}RT-1-changed.md`, `${FRAG}RT-1-fixed.md`]);
  assert.equal(r.decision, FORCE_FULL);
  assert.match(r.reason, /only neutral changes/);
});

test("a fragment never hides a forcing change, and the fragment is still recorded as neutral", () => {
  const r = guard.classify([`${SRC}inventory/x.ts`, `${FRAG}RT-1-changed.md`]);
  assert.equal(r.decision, FORCE_FULL);
  assert.deepEqual(r.forcing.map((f) => f.path), [`${SRC}inventory/x.ts`]);
  assert.deepEqual(r.neutral, [`${FRAG}RT-1-changed.md`]);
});

test("deleted, renamed-away, special-mode, nested and non-md changelog paths are not neutral", () => {
  const forced = [
    { status: "D", mode: "100644", path: `${FRAG}RT-1-changed.md` },
    { status: "T", mode: "120000", path: `${FRAG}RT-1-changed.md` },
    { status: "A", mode: "120000", path: `${FRAG}RT-1-changed.md` },
    { status: "A", mode: "100644", path: `${FRAG}sub/RT-1-changed.md` },
    { status: "A", mode: "100644", path: `${FRAG}RT-1-changed.txt` },
    { status: "A", mode: "100644", path: "changelog.d/RT-1-changed.md" },
    { status: "A", mode: "100644", path: `${FRAG}../x.md` },
  ];
  for (const c of forced) {
    assert.equal(guard.isNeutral(c), false, JSON.stringify(c));
    assert.equal(guard.classify([`${SRC}x.ts`, c]).decision, FORCE_FULL, JSON.stringify(c));
  }
});

test("the must-run spec exists in the repository", () => {
  for (const spec of guard.NEUTRAL_MUST_RUN) {
    assert.ok(fs.existsSync(path.join(ROOT, "services/backend-core/apps/api", spec)), spec);
  }
});

test("the code-health baseline is neutral with no must-run spec", () => {
  const BASE = "services/backend-core/tools/code-health/baseline.json";
  const r = guard.classify([`${SRC}x.ts`, BASE]);
  assert.equal(r.decision, TIA_ELIGIBLE);
  assert.deepEqual(r.neutral, [BASE]);
  assert.deepEqual(r.mustRun, []);
  const both = guard.classify([`${SRC}x.ts`, BASE, `${FRAG}RT-1-changed.md`]);
  assert.equal(both.decision, TIA_ELIGIBLE);
  assert.deepEqual(both.mustRun, ["test/tooling/changelog-fragments.spec.ts"]);
  assert.equal(guard.classify([BASE]).decision, FORCE_FULL, "baseline alone is not measurable");
  for (const c of [
    { status: "D", mode: "100644", path: BASE },
    { status: "A", mode: "100644", path: "services/backend-core/tools/code-health/other.json" },
    { status: "A", mode: "100644", path: "services/backend-core/apps/api/tools/code-health/baseline.json" },
  ]) {
    assert.equal(guard.classify([`${SRC}x.ts`, c]).decision, FORCE_FULL, JSON.stringify(c));
  }
});

test("no API spec or helper reads the code-health baseline (so it needs no must-run spec)", () => {
  // A heuristic, not a proof: it looks for the literal names. Widen it if a reader appears.
  const bc = path.join(ROOT, "services/backend-core");
  const roots = ["apps/api/src", "apps/api/test", "tools/test-support", "tools/changelog"].map((r) => path.join(bc, r));
  const hits = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") walk(p);
      } else if (/\.(ts|cjs|mjs|js)$/.test(e.name) && /code-health|baseline\.json/.test(fs.readFileSync(p, "utf8"))) {
        hits.push(path.relative(bc, p));
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(hits, []);
});
