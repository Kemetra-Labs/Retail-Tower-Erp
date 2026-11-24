// RT-1592: spec for .github/release/release-hold.cjs, the read-only, fail-closed release hold check of the POS and
// POS Pilot releases. Run: node --test .github/release/release-hold.test.cjs
// The decision logic runs against an injected git; the real git adapter and the CLI run against a throwaway repository.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const hold = require("./release-hold.cjs");

const SCRIPT = path.join(__dirname, "release-hold.cjs");
const MANIFEST_FILE = path.join(__dirname, "release-holds.json");
const RELEASE = "a".repeat(40);
const CLEAR_1 = "1".repeat(40);
const CLEAR_2 = "2".repeat(40);
const TEST_A = "apps/pos/src/renderer/__tests__/parked-list-scale.test.tsx";
const TEST_B = "apps/pos/src/renderer/__tests__/parked-bulk-cancel.test.tsx";
const ENTRY_A = "apps/pos/src/renderer/pages/ParkedSales.tsx";
const ENTRY_B = "apps/pos/src/main/parked-bulk-cancel.ts";

const openManifest = () => ({
  schema: 1,
  holds: [{ id: "park-limit", reason: "no-default-limit needs RT-1562 and RT-1563", products: ["pos", "pos-pilot"], status: "open", lifted_by: ["RT-1562", "RT-1563"] }],
});

const clearedManifest = () => ({
  schema: 1,
  holds: [
    {
      id: "park-limit",
      reason: "no-default-limit needs RT-1562 and RT-1563",
      products: ["pos", "pos-pilot"],
      status: "cleared",
      capabilities: [
        { name: "parked-list-at-scale", clearing_shas: [CLEAR_1], tests: [TEST_A], entry_points: [ENTRY_A] },
        { name: "manager-bulk-cancel", clearing_shas: [CLEAR_2], tests: [TEST_B], entry_points: [ENTRY_B] },
      ],
    },
  ],
});

/** A fake git where everything is present and clean; each override changes one answer. */
function fakeGit(overrides = {}) {
  const files = new Set([TEST_A, TEST_B, ENTRY_A, ENTRY_B]);
  return {
    commitExists: () => true,
    isAncestor: () => true,
    reverts: () => [],
    isFile: (_sha, file) => files.has(file),
    ...overrides,
  };
}

const judge = (manifest, over = {}) =>
  hold.evaluateHold({ manifest, sha: RELEASE, product: "pos-pilot", guardVerdict: "PASS", git: fakeGit(), ...over });

const refusedWith = (result, text) => {
  assert.equal(result.verdict, "REFUSED", JSON.stringify(result));
  assert.ok(result.problems.some((p) => p.includes(text)), `expected a problem containing "${text}", got ${JSON.stringify(result.problems)}`);
};

// ---- criterion 1: an open hold refuses and names the hold ---------------------------------------------------------

test("an open hold refuses for each product it applies to and names the hold, its reason and what lifts it", () => {
  for (const product of ["pos", "pos-pilot"]) {
    const result = judge(openManifest(), { product });
    refusedWith(result, "hold 'park-limit' is open");
    refusedWith(result, "RT-1562 and RT-1563");
  }
});

test("an open hold refuses even when every other input looks perfect, and never consults git", () => {
  const boom = () => assert.fail("git must not be needed for an open hold");
  const result = judge(openManifest(), { git: { commitExists: boom, isAncestor: boom, reverts: boom, isFile: boom } });
  refusedWith(result, "is open");
});

test("an open hold that does not apply to the product does not refuse it", () => {
  const manifest = openManifest();
  manifest.holds[0].products = ["pos"];
  const result = judge(manifest, { product: "pos-pilot" });
  assert.equal(result.verdict, "PASS");
  assert.ok(result.notes.some((n) => n.includes("no hold applies to pos-pilot")));
});

test("the committed manifest is well formed and holds the park-limit hold open for both products", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  assert.equal(hold.manifestProblem(manifest), null);
  assert.equal(manifest.holds.length, 1);
  assert.deepEqual(
    { id: manifest.holds[0].id, status: manifest.holds[0].status, products: manifest.holds[0].products, lifted_by: manifest.holds[0].lifted_by },
    { id: "park-limit", status: "open", products: ["pos", "pos-pilot"], lifted_by: ["RT-1562", "RT-1563"] },
  );
  for (const product of ["pos", "pos-pilot"]) {
    refusedWith(hold.evaluateHold({ manifest, sha: RELEASE, product, guardVerdict: "PASS", git: fakeGit() }), "hold 'park-limit' is open");
  }
});

// ---- criterion 2: clearing SHAs must be ancestors and not reverted ----------------------------------------------

test("a cleared hold whose clearing SHA is not an ancestor of the release SHA refuses and names that SHA", () => {
  const result = judge(clearedManifest(), { git: fakeGit({ isAncestor: (clearing) => clearing !== CLEAR_2 }) });
  refusedWith(result, `clearing SHA ${CLEAR_2} is not an ancestor of the release SHA ${RELEASE}`);
  assert.equal(result.problems.length, 1, "only the missing ancestor is reported");
});

test("a cleared hold whose clearing SHA does not exist in the history read refuses", () => {
  refusedWith(judge(clearedManifest(), { git: fakeGit({ commitExists: (s) => s !== CLEAR_1 }) }), `clearing SHA ${CLEAR_1} is not a commit in the history read`);
});

test("a cleared hold whose clearing SHA is reverted in the history refuses and names the SHA and the revert", () => {
  const revert = "c".repeat(40);
  const result = judge(clearedManifest(), { git: fakeGit({ reverts: (clearing) => (clearing === CLEAR_1 ? [revert] : []) }) });
  refusedWith(result, `clearing SHA ${CLEAR_1} is reverted by ${revert}`);
});

// ---- criterion 3: evidence tests and production entry points must exist ------------------------------------------

test("a cleared hold whose evidence test file is missing at the release SHA refuses and names it", () => {
  const missing = new Set([TEST_B]);
  const result = judge(clearedManifest(), { git: fakeGit({ isFile: (_s, f) => !missing.has(f) }) });
  refusedWith(result, `evidence test file ${TEST_B} is missing from the release SHA`);
});

test("a cleared hold whose production entry point is missing at the release SHA refuses and names it", () => {
  const missing = new Set([ENTRY_A]);
  const result = judge(clearedManifest(), { git: fakeGit({ isFile: (_s, f) => !missing.has(f) }) });
  refusedWith(result, `production entry point ${ENTRY_A} is missing from the release SHA`);
});

// ---- criterion 4: complete evidence plus a green pos/test passes ---------------------------------------------------

test("a cleared hold with all evidence present, nothing reverted and the CI guard passing passes", () => {
  const result = judge(clearedManifest());
  assert.deepEqual(result.problems, []);
  assert.equal(result.verdict, "PASS");
  assert.ok(result.notes.some((n) => n.includes("hold 'park-limit': cleared and verified")));
});

test("ancestry alone is never enough: a cleared hold passes only when the CI guard (pos/test) also passed", () => {
  for (const guardVerdict of ["REFUSED", "", undefined, "pass", "SKIPPED"]) {
    const result = judge(clearedManifest(), { guardVerdict });
    refusedWith(result, "the release CI guard verdict is");
    refusedWith(result, "pos/test is not proven");
  }
});

// ---- criterion 5: anything malformed, unreadable, missing or unknown refuses ----------------------------------------

test("a manifest that is missing, not an object or on another schema refuses", () => {
  for (const manifest of [null, undefined, [], "x", 3, { schema: 2, holds: [] }, { holds: [] }, { schema: 1 }, { schema: 1, holds: {} }]) {
    assert.equal(judge(manifest).verdict, "REFUSED", JSON.stringify(manifest));
  }
});

test("an unknown status, a missing reason, bad products, a bad id or a duplicate id refuses", () => {
  const cases = {
    "unknown status": (m) => (m.holds[0].status = "closed"),
    "no status": (m) => delete m.holds[0].status,
    "no reason": (m) => delete m.holds[0].reason,
    "no products": (m) => (m.holds[0].products = []),
    "unknown product": (m) => (m.holds[0].products = ["pos", "console"]),
    "bad id": (m) => (m.holds[0].id = "Park Limit"),
    "duplicate id": (m) => m.holds.push({ ...m.holds[0] }),
    "hold is not an object": (m) => (m.holds[0] = "park-limit"),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const manifest = openManifest();
    mutate(manifest);
    assert.equal(judge(manifest).verdict, "REFUSED", name);
  }
});

test("a cleared hold with a missing or malformed evidence list refuses before git is read", () => {
  const cases = {
    "no capabilities": (m) => delete m.holds[0].capabilities,
    "empty capabilities": (m) => (m.holds[0].capabilities = []),
    "capability without a name": (m) => delete m.holds[0].capabilities[0].name,
    "no clearing SHA": (m) => (m.holds[0].capabilities[0].clearing_shas = []),
    "short clearing SHA": (m) => (m.holds[0].capabilities[0].clearing_shas = ["abc1234"]),
    "uppercase clearing SHA": (m) => (m.holds[0].capabilities[0].clearing_shas = ["A".repeat(40)]),
    "no tests": (m) => delete m.holds[0].capabilities[0].tests,
    "empty tests": (m) => (m.holds[0].capabilities[0].tests = []),
    "no entry points": (m) => delete m.holds[0].capabilities[1].entry_points,
    "parent path": (m) => (m.holds[0].capabilities[0].tests = ["apps/pos/../../etc/passwd"]),
    "absolute path": (m) => (m.holds[0].capabilities[0].entry_points = ["/apps/pos/a.ts"]),
    "backslash path": (m) => (m.holds[0].capabilities[0].tests = ["apps\\pos\\a.test.ts"]),
    "path with a space": (m) => (m.holds[0].capabilities[0].tests = ["apps/pos/a b.test.ts"]),
    "non-string path": (m) => (m.holds[0].capabilities[0].tests = [42]),
  };
  const boom = () => assert.fail("git must not be read for a malformed manifest");
  for (const [name, mutate] of Object.entries(cases)) {
    const manifest = clearedManifest();
    mutate(manifest);
    const result = judge(manifest, { git: { commitExists: boom, isAncestor: boom, reverts: boom, isFile: boom } });
    assert.equal(result.verdict, "REFUSED", name);
  }
});

test("an unreadable history or tree refuses: a throwing git is a refusal, never a pass", () => {
  const broken = (what) => () => {
    throw new Error(`fatal: ${what}\nsecond line is dropped`);
  };
  for (const method of ["commitExists", "isAncestor", "reverts"]) {
    const result = judge(clearedManifest(), { git: fakeGit({ [method]: broken("bad object") }) });
    refusedWith(result, "is unreadable (fatal: bad object)");
  }
  refusedWith(judge(clearedManifest(), { git: fakeGit({ isFile: broken("not a tree") }) }), "the tree of the release SHA is unreadable");
});

test("a bad release SHA or an unknown product refuses before anything else is trusted", () => {
  for (const sha of ["", "abc", "A".repeat(40), undefined, null, `${"a".repeat(39)}g`]) {
    refusedWith(judge(clearedManifest(), { sha }), "release SHA is not a 40-character lowercase hex SHA");
  }
  refusedWith(judge(clearedManifest(), { product: "console" }), "product 'console' is not one of");
});

test("every one of several capabilities must be proven: one failing capability refuses the hold", () => {
  const result = judge(clearedManifest(), { git: fakeGit({ isFile: (_s, f) => f !== ENTRY_B }) });
  refusedWith(result, ENTRY_B);
  assert.ok(result.notes.some((n) => n.includes("cleared but NOT verified")));
});

test("output is one line per problem: control characters in manifest text cannot start a workflow command", () => {
  const manifest = openManifest();
  manifest.holds[0].reason = "x\n::set-output name=pwn::1\r\n::error::fake";
  const result = judge(manifest);
  for (const line of [...result.problems, ...result.notes]) assert.doesNotMatch(line, /[\r\n]/);
});

// ---- the real git adapter and the CLI, against a throwaway repository ----------------------------------------------

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** main: base -> clearing commit (adds the evidence files) -> later commit. Returns the SHAs and the directory. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-hold-"));
  git(dir, "init", "-q", "-b", "main");
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write("README.md", "base\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  write("apps/pos/a.test.ts", "test\n");
  write("apps/pos/a.ts", "entry\n");
  git(dir, "add", "apps/pos/a.test.ts", "apps/pos/a.ts");
  git(dir, "commit", "-q", "-m", "feat: the capability");
  const clearing = git(dir, "rev-parse", "HEAD");
  write("later.txt", "later\n");
  git(dir, "add", "later.txt");
  git(dir, "commit", "-q", "-m", "chore: later work");
  const release = git(dir, "rev-parse", "HEAD");
  return { dir, base, clearing, release, write };
}

function manifestFor(dir, clearing, extra = {}) {
  const manifest = {
    schema: 1,
    holds: [
      {
        id: "park-limit",
        reason: "r",
        products: ["pos", "pos-pilot"],
        status: "cleared",
        capabilities: [{ name: "cap", clearing_shas: [clearing], tests: ["apps/pos/a.test.ts"], entry_points: ["apps/pos/a.ts"], ...extra }],
      },
    ],
  };
  const file = path.join(dir, "holds.json");
  fs.writeFileSync(file, JSON.stringify(manifest));
  return file;
}

function cli(dir, manifest, sha, product = "pos-pilot", guard = "PASS") {
  return spawnSync(process.execPath, [SCRIPT, "--manifest", manifest, "--sha", sha, "--product", product, "--guard-verdict", guard], { cwd: dir, encoding: "utf8" });
}

test("the CLI passes a cleared hold whose evidence is real, and refuses the same hold on the open committed manifest", () => {
  const repo = makeRepo();
  try {
    const ok = cli(repo.dir, manifestFor(repo.dir, repo.clearing), repo.release);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /Release hold: PASS/);
    const open = cli(repo.dir, MANIFEST_FILE, repo.release);
    assert.equal(open.status, 1, open.stdout);
    assert.match(open.stdout, /::error::hold 'park-limit' is open/);
    assert.match(open.stdout, /Release hold: REFUSED/);
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("the real git adapter refuses a clearing SHA that is not an ancestor, one that is unknown, and a missing file", () => {
  const repo = makeRepo();
  try {
    git(repo.dir, "checkout", "-q", "-b", "side", repo.base);
    repo.write("side.txt", "side\n");
    git(repo.dir, "add", "side.txt");
    git(repo.dir, "commit", "-q", "-m", "side commit");
    const side = git(repo.dir, "rev-parse", "HEAD");
    git(repo.dir, "checkout", "-q", "main");

    const notAncestor = cli(repo.dir, manifestFor(repo.dir, side), repo.release);
    assert.equal(notAncestor.status, 1);
    assert.match(notAncestor.stdout, new RegExp(`clearing SHA ${side} is not an ancestor of the release SHA ${repo.release}`));

    const unknown = cli(repo.dir, manifestFor(repo.dir, "f".repeat(40)), repo.release);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stdout, /clearing SHA f{40} is not a commit in the history read/);

    const noFile = cli(repo.dir, manifestFor(repo.dir, repo.clearing, { tests: ["apps/pos/missing.test.ts"] }), repo.release);
    assert.equal(noFile.status, 1);
    assert.match(noFile.stdout, /evidence test file apps\/pos\/missing\.test\.ts is missing from the release SHA/);

    const dirAsFile = cli(repo.dir, manifestFor(repo.dir, repo.clearing, { entry_points: ["apps/pos"] }), repo.release);
    assert.equal(dirAsFile.status, 1, "a directory is not a production entry point file");
    assert.match(dirAsFile.stdout, /production entry point apps\/pos is missing/);

    // The evidence is looked up in the RELEASE SHA's tree, not the working tree: a file only in the checkout does not count.
    repo.write("only-in-checkout.ts", "x\n");
    const inTree = cli(repo.dir, manifestFor(repo.dir, repo.clearing, { entry_points: ["only-in-checkout.ts"] }), repo.release);
    assert.equal(inTree.status, 1);
    assert.match(inTree.stdout, /production entry point only-in-checkout\.ts is missing/);
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("the real git adapter finds a revert of the clearing SHA by its `This reverts commit` line", () => {
  const repo = makeRepo();
  try {
    git(repo.dir, "revert", "--no-edit", repo.clearing);
    const afterRevert = git(repo.dir, "rev-parse", "HEAD");
    const result = cli(repo.dir, manifestFor(repo.dir, repo.clearing), afterRevert);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, new RegExp(`clearing SHA ${repo.clearing} is reverted by ${afterRevert}`));
    // The files the revert removed are also gone from that release SHA: the entry point check refuses independently.
    assert.match(result.stdout, /production entry point apps\/pos\/a\.ts is missing/);

    // A revert of some OTHER commit does not refuse this clearing SHA.
    const other = makeRepo();
    try {
      other.write("x.txt", "x\n");
      git(other.dir, "add", "x.txt");
      git(other.dir, "commit", "-q", "-m", "feat: unrelated");
      const unrelated = git(other.dir, "rev-parse", "HEAD");
      git(other.dir, "revert", "--no-edit", unrelated);
      const tip = git(other.dir, "rev-parse", "HEAD");
      const fine = cli(other.dir, manifestFor(other.dir, other.clearing), tip);
      assert.equal(fine.status, 0, fine.stdout);
    } finally {
      fs.rmSync(other.dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("the real git adapter works in a shallow clone only as far as history reaches: a clearing SHA it cannot see refuses", () => {
  const repo = makeRepo();
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "release-hold-shallow-"));
  try {
    const cloned = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${repo.dir}`, clone], { encoding: "utf8" });
    assert.equal(cloned.status, 0, cloned.stderr);
    const result = cli(clone, manifestFor(clone, repo.base), repo.release);
    assert.equal(result.status, 1, result.stdout);
    assert.doesNotMatch(result.stdout, /Release hold: PASS/);
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  }
});

test("the CLI refuses an unreadable, oversized or missing manifest and a git failure, and rejects bad usage with exit 2", () => {
  const repo = makeRepo();
  try {
    const missing = cli(repo.dir, path.join(repo.dir, "nope.json"), repo.release);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /Release hold: REFUSED/);

    const garbage = path.join(repo.dir, "garbage.json");
    fs.writeFileSync(garbage, "{not json");
    assert.equal(cli(repo.dir, garbage, repo.release).status, 1);

    const big = path.join(repo.dir, "big.json");
    fs.writeFileSync(big, JSON.stringify({ schema: 1, holds: [], pad: "x".repeat(1024 * 1024 + 1) }));
    assert.equal(cli(repo.dir, big, repo.release).status, 1);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "release-hold-nogit-"));
    try {
      const noGit = cli(outside, manifestFor(repo.dir, repo.clearing), repo.release);
      assert.equal(noGit.status, 1, "outside a repository every git read fails and the result is a refusal");
      assert.match(noGit.stdout, /unreadable/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }

    for (const args of [[], ["--manifest", MANIFEST_FILE], ["--manifest", MANIFEST_FILE, "--sha", repo.release], ["--manifest", MANIFEST_FILE, "--sha", repo.release, "--product"], ["stray"]]) {
      const usage = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo.dir, encoding: "utf8" });
      assert.equal(usage.status, 2, args.join(" "));
    }
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("the check is read-only and offline: it uses no network, no workflow command and no write API", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  const code = source.replace(/^\/\/.*$/gm, "");
  for (const forbidden of ["http", "fetch(", "writeFile", "appendFile", "unlink", "rmSync", "spawn(", "exec("]) {
    assert.ok(!code.includes(forbidden), `release-hold.cjs must not contain ${forbidden}`);
  }
  assert.match(source, /execFileSync\("git"/, "git is the only process it starts, with a fixed argument list and no shell");
});
