/**
 * RT-703 + RT-842 — the offline release verifier of the lab deploy
 * (deploy/lab/verify-release.cjs). The checks run the real refusal logic
 * against generated evidence, so every refusal path is exercised without cloud
 * credentials or host access. The product workflow that ran it (deploy-lab.yml)
 * and its checks were retired in RT-878: GitHub never ran it from a nested
 * .github/, and the lab deploy is to be rebuilt on the monorepo release.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
// Normalise CRLF so checkouts with core.autocrlf behave like CI.
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

type Ctx = {
  release: string;
  jiraKey: string;
  target: string;
  mode: string;
  currentRelease?: string | null;
  now?: string;
  transport?: { roleArn?: string; ssmNodeId?: string; environmentReviewers?: number } | null;
};
type Ledger = {
  mode: string;
  outcome: string;
  release: { tag: string; sha: string | null };
  images: Record<string, { digest: string; ref: string }>;
  compat: { mode: string | null; notes: string[] };
  plan: {
    steps: { step: string; status: string }[];
    grants: string[];
    catchups: string[];
    migrations: {
      targetCount: number;
      added: string[] | null;
      removed: string[] | null;
      changed: string[] | null;
      rollback: { allowed: boolean };
    } | null;
  };
  gates: { environment: { status: string }; transport: { status: string } };
  pendingApprovals: string[];
  failureBoundary: string | null;
  refusals: string[];
};
type Helper = {
  REQUIRED_CHECKS: string[];
  SIGNER_WORKFLOW: string;
  evaluate: (dir: string, ctx: Ctx) => { refusals: string[]; ledger: Ledger };
  assessRollback: (added: string[], removed: string[]) => { allowed: boolean; reason: string };
  checkTransport: (identity: Ctx["transport"]) => string[];
  renderSummary: (ledger: Ledger) => string;
  main: (argv: string[]) => number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const helper = require(resolve(repoRoot, "deploy/lab/verify-release.cjs")) as Helper;
// the same CommonJS fs object the verifier uses, so a spy on it reaches the verifier
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs = require("node:fs") as typeof import("node:fs");

// ---------------------------------------------------------------- verifier

const SHA = "1711813df1f36d7ed60db1096f9a23c2be1e81c3";
const OLD_SHA = "ff9e68331415c29aa21ba3ece6af3e2f62b22646";
const TAG = `backend-core-${SHA.slice(0, 12)}`;
const OLD_TAG = `backend-core-${OLD_SHA.slice(0, 12)}`;
const BUNDLE = `backend-core-release-${SHA.slice(0, 12)}`;
const DIGESTS: Record<string, string> = {
  api: `sha256:${"a".repeat(64)}`,
  worker: `sha256:${"b".repeat(64)}`,
  migrate: `sha256:${"c".repeat(64)}`,
};
const ref = (target: string): string => `ghcr.io/kemetra/backend-core-${target}@${DIGESTS[target] ?? ""}`;
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ release: TAG, jiraKey: "RT-703", target: "lab-01", mode: "dry-run", ...over });

const MIGRATIONS = [
  "packages/db/drizzle/0001_init.down.sql",
  "packages/db/drizzle/0001_init.sql",
  "packages/db/drizzle/0002_sales.down.sql",
  "packages/db/drizzle/0002_sales.sql",
  "packages/db/drizzle/meta",
];
const UP = MIGRATIONS.filter((m) => m.endsWith(".sql") && !m.endsWith(".down.sql"));
/** `git ls-tree <sha> packages/db/drizzle/` output; a blob ID is derived from the path unless overridden. */
const lsTree = (paths: string[], blobs: Record<string, string> = {}): string =>
  paths
    .map((p) => {
      const type = p.endsWith(".sql") ? "100644 blob" : "040000 tree";
      const blob = blobs[p] ?? createHash("sha256").update(p).digest("hex").slice(0, 40);
      return `${type} ${blob}\t${p}`;
    })
    .join("\n");

let dir: string;

function put(rel: string, content: string | Buffer): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
const putJson = (rel: string, value: unknown): void => put(rel, JSON.stringify(value));
const sums = (entries: Record<string, string | Buffer>): string =>
  Object.entries(entries).map(([name, content]) => `${hash(content)}  ${name}\n`).join("");

function attestation(target: string, over: Record<string, string> = {}): unknown {
  return [
    {
      verificationResult: {
        statement: {
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ digest: { sha256: (DIGESTS[target] ?? "").slice(7) } }],
        },
        signature: {
          certificate: {
            sourceRepositoryDigest: SHA,
            sourceRepositoryRef: "refs/heads/main",
            buildSignerURI: helper.SIGNER_WORKFLOW,
            ...over,
          },
        },
      },
    },
  ];
}

function bundleFiles(): Record<string, string> {
  return {
    "docker-compose.release.yml": "services: {}\n",
    "docs/operations/sql/cashier-admissions-domain-grants.sql": "select 1;\n",
    "docs/operations/sql/erpnext-posting-resolution-catchup.sql": "select 2;\n",
    "release.env": `# Release ${SHA}.\nDP2_MIGRATE_IMAGE=${ref("migrate")}\nDP2_API_IMAGE=${ref("api")}\nDP2_WORKER_IMAGE=${ref("worker")}\n`,
  };
}

function manifest(files: Record<string, string>): Record<string, unknown> {
  const image = (t: string) => ({ repository: `ghcr.io/kemetra/backend-core-${t}`, tag: `sha-${SHA}`, digest: DIGESTS[t], ref: ref(t) });
  return {
    schemaVersion: 1,
    repository: "Kemetra/Backend-Core",
    sha: SHA,
    releaseTag: TAG,
    published: true,
    digestKind: "registry-manifest-digest",
    createdAt: "2026-10-18T12:59:25Z",
    images: { api: image("api"), worker: image("worker"), migrate: image("migrate") },
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)])),
  };
}

/** Writes the release assets and the extracted bundle; returns the manifest text. */
function writeRelease(files: Record<string, string>, m: Record<string, unknown> = manifest(files)): string {
  const manifestText = JSON.stringify(m, null, 2);
  for (const [name, content] of Object.entries(files)) put(`bundle/${BUNDLE}/${name}`, content);
  put(`bundle/${BUNDLE}/release-manifest.json`, manifestText);
  put(`bundle/${BUNDLE}/SHA256SUMS`, sums({ ...files, "release-manifest.json": manifestText }));
  const tarball = Buffer.from("not really a tarball");
  put(`release/${BUNDLE}.tar.gz`, tarball);
  put("release/release-manifest.json", manifestText);
  put("release/SHA256SUMS", sums({ [`${BUNDLE}.tar.gz`]: tarball, "release-manifest.json": manifestText }));
  return manifestText;
}

/** Evidence for a release that passes every check. */
function writeGoodEvidence(): void {
  putJson("release.json", { tagName: TAG, targetCommitish: SHA, isDraft: false, isPrerelease: false, isImmutable: true });
  put("tag-commit.txt", `${SHA}\n`);
  writeRelease(bundleFiles());
  putJson("compare.json", { status: "ahead", ahead_by: 3, behind_by: 0, merge_base: SHA });
  putJson(
    "check-runs.json",
    helper.REQUIRED_CHECKS.map((name) => ({ name, conclusion: "success", slug: "github-actions", started_at: "2026-10-18T10:00:00Z" })),
  );
  for (const t of ["api", "worker", "migrate"]) putJson(`attest-${t}.json`, attestation(t));
  put("migrations-target.txt", lsTree(MIGRATIONS));
  writeSource(bundleFiles());
  putJson("environment.json", { status: "not-visible", reviewers: 0 });
}

/** `git archive <sha>` of the release commit: every shipped file except the generated release.env. */
function writeSource(files: Record<string, string>, allowlist?: string[]): void {
  rmSync(join(dir, "source"), { recursive: true, force: true });
  const shipped = Object.keys(files).filter((name) => name !== "release.env");
  for (const name of shipped) put(`source/${name}`, files[name] ?? "");
  put("source/unrelated/file.ts", "export {};\n");
  // the release commit's own bundle allowlist, in release-bundle.sh's format
  const entries = (allowlist ?? shipped).map((f) => `  ${f}`).join("\n");
  put("source/deploy/release-bundle.sh", `#!/usr/bin/env bash\n# Files shipped in the bundle.\nALLOWLIST=(\n${entries}\n)\n`);
  writeCompatSource();
}

const BUILD_A = "9dfd7d977267806a907d4c03a566382570cbd0c9";
const BUILD_B = "0123456789abcdef0123456789abcdef01234567";
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
// The repository's real matrix is the template, so every fixture passes contracts-compat's own
// validateStructure; only captured_at and the supported entries change.
const REAL_MATRIX = read("contracts-compat/pos-supported.yaml");
const SUPPORTED_AT = REAL_MATRIX.indexOf("\nsupported:\n") + 1;
const SYNTHETIC_AT = REAL_MATRIX.indexOf("\n# Test-only probes that prove the harness") + 1;
const REAL_ENTRY = REAL_MATRIX.slice(SUPPORTED_AT + "supported:\n".length, SYNTHETIC_AT);
const supportedEntry = (build: string): string => REAL_ENTRY.replace(`build_id: ${BUILD_A}`, `build_id: ${build}`);
/** The release commit's contracts-compat matrix: the real one with a chosen capture time and builds. */
function writeMatrix({ capturedAt = daysAgo(1), builds = [BUILD_A] }: { capturedAt?: string; builds?: string[] } = {}): void {
  const supported = builds.length ? `supported:\n${builds.map(supportedEntry).join("")}` : "supported: []\n";
  const head = REAL_MATRIX.slice(0, SUPPORTED_AT).replace(/^ {2}captured_at: .*$/m, `  captured_at: ${capturedAt}`);
  put("source/contracts-compat/pos-supported.yaml", `${head}${supported}${REAL_MATRIX.slice(SYNTHETIC_AT)}`);
}
const snapshotOf = (build: string): string => `pos-build-${build.slice(0, 12)}`;
function writeFixture(build: string, provenance: string, name = "outbox-replay.yaml"): void {
  put(
    `source/contracts-compat/replay/${snapshotOf(build)}/${name}`,
    `# fixture\nschema: retail-tower/pos-replay@1\nsnapshot: ${snapshotOf(build)}\nprovenance: ${provenance}\nevents:\n  - seq: 1\n`,
  );
}
/** Today's state: one supported build, a contract-derived fixture only (replay NOT_PROVEN for release mode). */
function writeCompatSource(): void {
  rmSync(join(dir, "source/contracts-compat"), { recursive: true, force: true });
  writeMatrix();
  writeFixture(BUILD_A, "contract-derived");
}

function writeCurrent(migrations: string[], blobs: Record<string, string> = {}): void {
  putJson("current-release.json", { tagName: OLD_TAG, targetCommitish: OLD_SHA, isDraft: false, isPrerelease: false, isImmutable: true });
  put("current-tag-commit.txt", `${OLD_SHA}\n`);
  putJson("compare-current.json", { status: "ahead", ahead_by: 9, behind_by: 0, merge_base: OLD_SHA });
  put("migrations-current.txt", lsTree(migrations, blobs));
}

const refusalsOf = (c: Ctx = ctx()): string[] => helper.evaluate(dir, c).refusals;
const expectRefused = (pattern: RegExp, c: Ctx = ctx()): void => {
  expect(refusalsOf(c)).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
};

beforeEach(() => {
  // the CLI reports one outcome line; keep test output clean
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  dir = mkdtempSync(join(tmpdir(), "rt703-evidence-"));
  writeGoodEvidence();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("verify-release: a good release", () => {
  it("passes every check and plans, without running, the full live sequence", () => {
    const { refusals, ledger } = helper.evaluate(dir, ctx());
    expect(refusals).toEqual([]);
    expect(ledger.outcome).toBe("planned");
    expect(ledger.mode).toBe("dry-run");
    expect(ledger.release).toEqual({ tag: TAG, sha: SHA });
    expect(Object.fromEntries(Object.entries(ledger.images).map(([t, i]) => [t, i.ref]))).toEqual({
      api: ref("api"),
      worker: ref("worker"),
      migrate: ref("migrate"),
    });
    expect(ledger.plan.steps).toHaveLength(8);
    expect(ledger.plan.steps.every((s) => s.status.startsWith("not-run"))).toBe(true);
    expect(ledger.plan.grants).toEqual(["docs/operations/sql/cashier-admissions-domain-grants.sql"]);
    expect(ledger.plan.catchups).toEqual(["docs/operations/sql/erpnext-posting-resolution-catchup.sql"]);
    expect(ledger.plan.migrations?.targetCount).toBe(2);
    expect(ledger.gates.transport.status).toBe("not-provisioned");
    expect(ledger.pendingApprovals.join("\n")).toMatch(/aws-lab environment/);
    expect(ledger.failureBoundary).toBeNull();
  });

  it("accepts an older release that is still reachable from main", () => {
    putJson("compare.json", { status: "identical", ahead_by: 0, behind_by: 0, merge_base: SHA });
    expect(refusalsOf()).toEqual([]);
  });

  it("writes ledger.json and summary.md and exits 0 from the CLI", () => {
    const out = join(dir, "out");
    const argv = ["--evidence", dir, "--out", out, "--release", TAG, "--jira-key", "RT-703", "--target", "lab-01", "--mode", "dry-run", "--current-release", ""];
    expect(helper.main(argv)).toBe(0);
    const ledger = JSON.parse(readFileSync(join(out, "ledger.json"), "utf8")) as Ledger;
    expect(ledger.outcome).toBe("planned");
    expect(readFileSync(join(out, "summary.md"), "utf8")).toContain("Nothing was deployed.");
  });

  it("exits 1 with a refused ledger, and 2 on a usage error", () => {
    putJson("compare.json", { status: "diverged", ahead_by: 1, behind_by: 1, merge_base: OLD_SHA });
    const out = join(dir, "out");
    expect(helper.main(["--evidence", dir, "--out", out, "--release", TAG, "--jira-key", "RT-703", "--target", "lab-01", "--mode", "dry-run"])).toBe(1);
    const ledger = JSON.parse(readFileSync(join(out, "ledger.json"), "utf8")) as Ledger;
    expect(ledger.outcome).toBe("refused");
    expect(ledger.failureBoundary).toMatch(/not reachable from main/);
    expect(helper.renderSummary(ledger)).toContain("### Refused");
    expect(helper.main(["--evidence", dir])).toBe(2);
  });
});

describe("verify-release: refusals", () => {
  it.each([
    [{ release: "backend-core-latest" }, /backend_release must be/],
    [{ jiraKey: "703" }, /jira_key must be/],
    [{ target: "lab-02" }, /target must be one of/],
    [{ currentRelease: "main" }, /current_release must be/],
    [{ mode: "apply" }, /mode must be/],
  ])("refuses bad input %o", (over, pattern) => expectRefused(pattern, ctx(over as Partial<Ctx>)));

  it.each([
    [{ isImmutable: false }, /not an immutable release/],
    [{ isDraft: true }, /draft or prerelease/],
    [{ targetCommitish: OLD_SHA }, /tag does not match its commit/],
    [{ targetCommitish: "main" }, /not a 40-hex commit SHA/],
  ])("refuses release metadata %o", (over, pattern) => {
    putJson("release.json", { tagName: TAG, targetCommitish: SHA, isDraft: false, isPrerelease: false, isImmutable: true, ...over });
    expectRefused(pattern);
  });

  it.each([
    [{ status: "behind", ahead_by: 0, behind_by: 2, merge_base: OLD_SHA }, /not reachable from main/],
    [{ status: "diverged", ahead_by: 1, behind_by: 1, merge_base: OLD_SHA }, /commit\(s\) that are not on main/],
    [{ status: "ahead", ahead_by: 1, behind_by: 0, merge_base: OLD_SHA }, /merge base/],
  ])("refuses unverified ancestry %o", (cmp, pattern) => {
    putJson("compare.json", cmp);
    expectRefused(pattern);
  });

  it("refuses when ancestry or CI evidence is missing", () => {
    rmSync(join(dir, "compare.json"));
    rmSync(join(dir, "check-runs.json"));
    expectRefused(/ancestry evidence missing/);
    expectRefused(/CI check-run evidence missing/);
  });

  it("refuses a missing or failed required check, judging only the latest github-actions run", () => {
    const [fast, db] = helper.REQUIRED_CHECKS;
    putJson("check-runs.json", [
      { name: fast, conclusion: "success", slug: "github-actions", started_at: "2026-10-18T09:00:00Z" },
      { name: fast, conclusion: "failure", slug: "github-actions", started_at: "2026-10-18T10:00:00Z" },
      { name: db, conclusion: "success", slug: "some-other-app", started_at: "2026-10-18T10:00:00Z" },
    ]);
    expect(refusalsOf()).toContain(`required check '${fast ?? ""}' is 'failure' on the release SHA`);
    expectRefused(/db-integration .* is 'missing'/);
    // RT-816: the packages/db + worker DB suites are their own required check.
    expectRefused(/db-package .* is 'missing'/);
  });

  // RT-816: db-package exists only from the commit that split it out of
  // db-integration. Before that, db-integration itself ran the packages/db and
  // worker DB suites, so a release is judged by its own ci.yml (equal strength).
  describe("db-package follows the release commit's own ci.yml", () => {
    const [fast, db, dbPackage, compat] = helper.REQUIRED_CHECKS;
    const green = (names: (string | undefined)[]): unknown[] =>
      names.map((name) => ({ name, conclusion: "success", slug: "github-actions", started_at: "2026-10-18T10:00:00Z" }));
    const SPLIT_CI = "jobs:\n  db-integration:\n    name: x\n  db-package:\n    name: y\n";
    const PRE_SPLIT_CI = "# db-package is not a job here\njobs:\n  db-integration:\n    name: x\n";

    it("requires db-package when the release's ci.yml defines the job", () => {
      put("source/.github/workflows/ci.yml", SPLIT_CI);
      putJson("check-runs.json", green([fast, db, compat]));
      expectRefused(/db-package .* is 'missing'/);
    });

    it("requires db-package from a CRLF copy of a post-split ci.yml", () => {
      put("source/.github/workflows/ci.yml", SPLIT_CI.replace(/\n/g, "\r\n"));
      putJson("check-runs.json", green([fast, db, compat]));
      expectRefused(/db-package .* is 'missing'/);
    });

    it.each([
      ["a trailing comment", "jobs:\n  db-package: # RT-816\n    name: y\n"],
      ["a quoted key", 'jobs:\n  "db-package":\n    name: y\n'],
      ["an anchor", "jobs:\n  db-package: &dbp\n    name: y\n"],
      ["4-space indentation", "jobs:\n    db-package:\n        name: y\n"],
    ])("requires db-package when the job key carries %s", (_label, ciYml) => {
      put("source/.github/workflows/ci.yml", ciYml);
      putJson("check-runs.json", green([fast, db, compat]));
      expectRefused(/db-package .* is 'missing'/);
    });

    it("requires db-package whenever the SHA has a db-package run, whatever ci.yml says", () => {
      put("source/.github/workflows/ci.yml", PRE_SPLIT_CI);
      putJson("check-runs.json", [
        ...(green([fast, db, compat]) as object[]),
        { name: dbPackage, conclusion: "failure", slug: "github-actions", started_at: "2026-10-18T10:00:00Z" },
      ]);
      expectRefused(/db-package .* is 'failure'/);
    });

    it("fails closed when .github in the release source is not a real directory", () => {
      rmSync(join(dir, "source/.github"), { recursive: true, force: true });
      put("decoy/workflows/ci.yml", PRE_SPLIT_CI);
      symlinkSync(join(dir, "decoy"), join(dir, "source/.github"));
      putJson("check-runs.json", green([fast, db, compat]));
      expectRefused(/db-package .* is 'missing'/);
    });

    it("does not require db-package for a release whose ci.yml predates it", () => {
      put("source/.github/workflows/ci.yml", PRE_SPLIT_CI);
      putJson("check-runs.json", green([fast, db, compat]));
      expect(refusalsOf()).toEqual([]);
    });

    it("still requires db-integration for a pre-split release", () => {
      put("source/.github/workflows/ci.yml", PRE_SPLIT_CI);
      putJson("check-runs.json", green([fast, compat]));
      expectRefused(/db-integration .* is 'missing'/);
    });

    it("fails closed: an unreadable ci.yml requires all three checks", () => {
      rmSync(join(dir, "source/.github"), { recursive: true, force: true });
      putJson("check-runs.json", green([fast, db, compat]));
      expectRefused(/db-package .* is 'missing'/);
      putJson("check-runs.json", green([fast, db, dbPackage, compat]));
      expect(refusalsOf()).toEqual([]);
    });
  });

  it("refuses a missing, tampered or padded release SHA256SUMS", () => {
    rmSync(join(dir, "release/SHA256SUMS"));
    expectRefused(/release SHA256SUMS missing/);
    writeRelease(bundleFiles());
    put(`release/${BUNDLE}.tar.gz`, "swapped tarball");
    expectRefused(/release SHA256SUMS: checksum mismatch for 'backend-core-release-/);
    writeRelease(bundleFiles());
    put("release/SHA256SUMS", `${readFileSync(join(dir, "release/SHA256SUMS"), "utf8")}${"0".repeat(64)}  extra.txt\n`);
    expectRefused(/release SHA256SUMS lists/);
  });

  it.each([
    [{ published: false, digestKind: "local-image-id" }, /not a published release/],
    [{ digestKind: "local-image-id" }, /not registry digests/],
    [{ sha: OLD_SHA }, /is not the release commit/],
    [{ schemaVersion: 2 }, /schemaVersion is 2/],
  ])("refuses a manifest with %o", (over, pattern) => {
    const files = bundleFiles();
    writeRelease(files, { ...manifest(files), ...over });
    expectRefused(pattern);
  });

  it.each([
    ["a malformed digest", { digest: "sha256:xyz" }, /api image is missing or not a digest ref/],
    ["a ref that is not the digest", { ref: "ghcr.io/kemetra/backend-core-api:latest" }, /api image is missing|latest/],
    ["a floating tag", { tag: "latest" }, /latest/],
    ["another commit's tag", { tag: `sha-${OLD_SHA}` }, /api image is missing or not a digest ref/],
  ])("refuses an api image with %s", (_label, over, pattern) => {
    const files = bundleFiles();
    const m = manifest(files);
    const images = m.images as Record<string, Record<string, unknown>>;
    writeRelease(files, { ...m, images: { ...images, api: { ...images.api, ...over } } });
    expectRefused(pattern);
  });

  it("refuses a bundle whose release.env does not match the manifest", () => {
    const files = { ...bundleFiles(), "release.env": `DP2_MIGRATE_IMAGE=${ref("migrate")}\nDP2_API_IMAGE=${ref("worker")}\nDP2_WORKER_IMAGE=${ref("worker")}\nDP2_EXTRA_IMAGE=${ref("api")}\n` };
    writeRelease(files);
    expectRefused(/release.env DP2_API_IMAGE does not match/);
    expectRefused(/unexpected variable 'DP2_EXTRA_IMAGE'/);
  });

  it("refuses a release.env that assigns a key twice, even when the last value is right", () => {
    const injected = `DP2_API_IMAGE=x; touch /tmp/pwned\n${bundleFiles()["release.env"] ?? ""}`;
    writeRelease({ ...bundleFiles(), "release.env": injected });
    expectRefused(/release.env line 1 is not a plain KEY=<digest ref> assignment/);
    const duplicated = `${bundleFiles()["release.env"] ?? ""}DP2_API_IMAGE=${ref("api")}\n`;
    writeRelease({ ...bundleFiles(), "release.env": duplicated });
    expectRefused(/release.env sets DP2_API_IMAGE more than once/);
  });

  it.each([
    ["an export prefix", `export DP2_API_IMAGE=${ref("api")}`],
    ["a quoted value", `DP2_API_IMAGE="${ref("api")}"`],
    ["a trailing command", `DP2_API_IMAGE=${ref("api")} && id`],
    ["a command substitution", `DP2_API_IMAGE=$(id)`],
  ])("refuses a release.env line with %s", (_label, line) => {
    writeRelease({ ...bundleFiles(), "release.env": `${line}\n${bundleFiles()["release.env"] ?? ""}` });
    expectRefused(/release.env line 1 is not a plain KEY=<digest ref> assignment/);
  });

  it("refuses a bundle file that no longer matches its checksums", () => {
    put(`bundle/${BUNDLE}/docs/operations/sql/cashier-admissions-domain-grants.sql`, "grant all;\n");
    expectRefused(/bundle SHA256SUMS: checksum mismatch/);
    expectRefused(/manifest file hash mismatch for 'docs\/operations\/sql\/cashier-admissions-domain-grants.sql'/);
  });

  it("refuses a bundle manifest that differs from the release asset, or an unsafe checksum path", () => {
    put(`bundle/${BUNDLE}/release-manifest.json`, "{}");
    expectRefused(/bundle release-manifest.json differs/);
    put(`bundle/${BUNDLE}/SHA256SUMS`, `${"0".repeat(64)}  ../escape.sql\n`);
    expectRefused(/unsafe path '..\/escape.sql'/);
  });

  it("refuses a missing extracted bundle", () => {
    rmSync(join(dir, "bundle"), { recursive: true });
    expectRefused(/extracted release bundle missing/);
  });

  it.each([
    ["no verified attestation", null, /no verified attestation for the worker image/],
    ["another source commit", { sourceRepositoryDigest: OLD_SHA }, /worker attestation does not bind/],
    ["another ref", { sourceRepositoryRef: "refs/heads/feature" }, /worker attestation does not bind/],
    ["another signer workflow", { buildSignerURI: "https://github.com/Kemetra/Backend-Core/.github/workflows/other.yml@refs/heads/main" }, /worker attestation does not bind/],
  ])("refuses the worker image with %s", (_label, over, pattern) => {
    if (over === null) rmSync(join(dir, "attest-worker.json"));
    else putJson("attest-worker.json", attestation("worker", over));
    expectRefused(pattern);
  });

  it("refuses an attestation for another image digest", () => {
    putJson("attest-migrate.json", attestation("api"));
    expectRefused(/migrate attestation does not bind/);
  });

  it("refuses a missing migration list", () => {
    rmSync(join(dir, "migrations-target.txt"));
    expectRefused(/target migration list missing/);
  });
});

// RT-863, owner decision MR-3 (RT-863 comment 13811): option (b) with automatic tightening.
// Creating a symlink needs privileges on Windows; CI (Linux) always runs the symlink case.
const itWithSymlinksCompat = process.platform === "win32" ? it.skip : it;
describe("verify-release: POS compat gate (RT-863)", () => {
  type Gate = {
    COMPAT_CHECK: string;
    MAX_CLOCK_SKEW_DAYS: number;
    evaluateCompat: (source: string, now?: Date) => { mode: string | null; problems: string[]; notes: string[] };
    main: (argv: string[]) => number;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const gate = require(resolve(repoRoot, "deploy/release-compat-gate.cjs")) as Gate;
  const COMPAT = "contracts-compat (POS supported snapshots)";
  const runs = (compat: Record<string, unknown> | null): unknown[] => [
    ...helper.REQUIRED_CHECKS.filter((n) => n !== COMPAT).map((name) => ({ name, conclusion: "success", slug: "github-actions", started_at: "2026-10-18T10:00:00Z" })),
    ...(compat ? [{ name: COMPAT, slug: "github-actions", started_at: "2026-10-18T10:00:00Z", ...compat }] : []),
  ];

  it("is a required check of both release gates, with no pre-split exemption", () => {
    expect(gate.COMPAT_CHECK).toBe(COMPAT);
    expect(helper.REQUIRED_CHECKS).toContain(COMPAT);
    put("source/.github/workflows/ci.yml", "jobs:\n  db-integration:\n    name: x\n");
    putJson("check-runs.json", runs(null));
    expectRefused(/required check 'contracts-compat \(POS supported snapshots\)' is 'missing' on the release SHA/);
  });

  it("refuses a release SHA without a compat run", () => {
    putJson("check-runs.json", runs(null));
    expectRefused(/required check 'contracts-compat \(POS supported snapshots\)' is 'missing'/);
  });

  it.each(["failure", "cancelled", "skipped", "timed_out", "neutral"])("refuses a compat run that is '%s'", (conclusion) => {
    putJson("check-runs.json", runs({ conclusion }));
    expectRefused(new RegExp(`required check 'contracts-compat \\(POS supported snapshots\\)' is '${conclusion}'`));
  });

  it("refuses a compat run from another app, and judges only the latest github-actions run", () => {
    putJson("check-runs.json", runs({ conclusion: "success", slug: "some-bot" }));
    expectRefused(/contracts-compat .* is 'missing'/);
    putJson("check-runs.json", [
      ...(runs({ conclusion: "success", started_at: "2026-10-18T09:00:00Z" }) as object[]),
      { name: COMPAT, conclusion: "failure", slug: "github-actions", started_at: "2026-10-18T11:00:00Z" },
    ]);
    expectRefused(/contracts-compat .* is 'failure'/);
  });

  it("does not block on release-mode replay NOT_PROVEN, and records it in the ledger and summary (option b)", () => {
    const { refusals, ledger } = helper.evaluate(dir, ctx());
    expect(refusals).toEqual([]);
    expect(ledger.compat.mode).toBe("pr+fleet");
    expect(ledger.compat.notes.join("\n")).toMatch(/NOT_PROVEN \(no recorded replay fixture for pos-build-9dfd7d977267\)/);
    expect(helper.renderSummary(ledger)).toMatch(/### POS compatibility[\s\S]*NOT\\_PROVEN/);
  });

  it("records NOT_PROVEN, not a pass, when nothing is supported (bootstrap exception)", () => {
    writeMatrix({ builds: [] });
    const { refusals, ledger } = helper.evaluate(dir, ctx());
    expect(refusals).toEqual([]);
    expect(ledger.compat.mode).toBe("pr+fleet");
    expect(ledger.compat.notes.join("\n")).toMatch(/NOT_PROVEN \(no supported snapshot\)/);
  });

  it("refuses a stale fleet baseline at deploy time, even with a green PR-mode run", () => {
    writeMatrix({ capturedAt: daysAgo(7.5) });
    expectRefused(/FAIL_STALE_FLEET: fleet_baseline.captured_at is 7\.5 days old \(limit 7\)/);
    writeMatrix({ capturedAt: daysAgo(6.5) });
    expect(refusalsOf()).toEqual([]);
  });

  it("judges freshness at the verifier's clock, not the CI run's", () => {
    writeMatrix({ capturedAt: "2026-10-24T09:12:29Z" });
    expect(refusalsOf(ctx({ now: "2026-10-30T00:00:00Z" }))).toEqual([]);
    expectRefused(/FAIL_STALE_FLEET/, ctx({ now: "2026-11-01T00:00:00Z" }));
  });

  it("refuses a fleet baseline captured in the future", () => {
    writeMatrix({ capturedAt: daysAgo(-1) });
    expectRefused(/fleet_baseline.captured_at is in the future/);
  });

  it("switches to release mode by itself once every supported snapshot has a recorded fixture", () => {
    writeFixture(BUILD_A, "recorded", "terminal-capture.yaml");
    const { refusals, ledger } = helper.evaluate(dir, ctx());
    expect(refusals).toEqual([]);
    expect(ledger.compat.mode).toBe("release");
    expect(ledger.compat.notes.join("\n")).toMatch(/--mode release semantics/);
    expect(ledger.compat.notes.join("\n")).not.toMatch(/NOT_PROVEN/);
    // release mode still needs the green compat run and a fresh fleet
    putJson("check-runs.json", runs({ conclusion: "failure" }));
    expectRefused(/contracts-compat .* is 'failure'/);
    putJson("check-runs.json", runs({ conclusion: "success" }));
    writeMatrix({ capturedAt: daysAgo(10) });
    expectRefused(/FAIL_STALE_FLEET/);
  });

  it("stays in PR mode while any supported snapshot still lacks a recorded fixture", () => {
    writeMatrix({ builds: [BUILD_A, BUILD_B] });
    writeFixture(BUILD_A, "recorded");
    writeFixture(BUILD_B, "contract-derived");
    const { refusals, ledger } = helper.evaluate(dir, ctx());
    expect(refusals).toEqual([]);
    expect(ledger.compat.mode).toBe("pr+fleet");
    expect(ledger.compat.notes.join("\n")).toMatch(/no recorded replay fixture for pos-build-0123456789ab/);
    expect(ledger.compat.notes.join("\n")).not.toMatch(/pos-build-9dfd7d977267/);
  });

  it("fails closed when the release commit's matrix is missing, unreadable or unexpected", () => {
    rmSync(join(dir, "source/contracts-compat/pos-supported.yaml"));
    expectRefused(/POS compat gate .*pos-supported.yaml is missing or unreadable/);
    put("source/contracts-compat/pos-supported.yaml", "fleet_baseline:\n\tcaptured_at: x\n");
    expectRefused(/cannot read .*tab character/);
    writeMatrix();
    const text = readFileSync(join(dir, "source/contracts-compat/pos-supported.yaml"), "utf8");
    put("source/contracts-compat/pos-supported.yaml", text.replace(/^ {2}captured_at: .*\n/m, ""));
    expectRefused(/invalid matrix: fleet_baseline: missing or invalid captured_at/);
    put("source/contracts-compat/pos-supported.yaml", text.replace(/^ {2}- kind: build$/m, "  - kind: tablet"));
    expectRefused(/unknown kind 'tablet'/);
    put("source/contracts-compat/pos-supported.yaml", `${text}supported: []\n`);
    expectRefused(/duplicate key 'supported'/);
  });

  it("reads any indentation contracts-compat's own parser accepts (Codex P2 on #922)", () => {
    writeMatrix();
    const text = readFileSync(join(dir, "source/contracts-compat/pos-supported.yaml"), "utf8");
    // two more spaces under every top-level key: still the same matrix to parseYamlSubset
    put("source/contracts-compat/pos-supported.yaml", text.replace(/^(?= )/gm, "  "));
    const { refusals, ledger } = helper.evaluate(dir, ctx());
    expect(refusals).toEqual([]);
    expect(ledger.compat.notes.join("\n")).toMatch(/no recorded replay fixture for pos-build-9dfd7d977267/);
  });

  it("fails closed on an unreadable fixture index", () => {
    put(`source/contracts-compat/replay/${snapshotOf(BUILD_A)}/broken.yaml`, "schema: x\nevents: []\n");
    expectRefused(/replay fixtures for pos-build-9dfd7d977267 are unreadable/);
    rmSync(join(dir, `source/contracts-compat/replay/${snapshotOf(BUILD_A)}/broken.yaml`));
    for (const bad of ['"recorded', "'recorded", '"rec\\qorded"']) {
      writeFixture(BUILD_A, bad);
      expectRefused(/replay fixtures for pos-build-9dfd7d977267 are unreadable/);
    }
  });

  it("refuses a malformed fixture with a ledger, not a crash, from the CLI", () => {
    writeFixture(BUILD_A, '"recorded');
    const out = join(dir, "out");
    expect(helper.main(["--evidence", dir, "--out", out, "--release", TAG, "--jira-key", "RT-703", "--target", "lab-01", "--mode", "dry-run"])).toBe(1);
    const ledger = JSON.parse(readFileSync(join(out, "ledger.json"), "utf8")) as Ledger;
    expect(ledger.refusals.join("\n")).toMatch(/replay fixtures for pos-build-9dfd7d977267 are unreadable/);
    expect(gate.main(["--source", join(dir, "source")])).toBe(1);
  });

  itWithSymlinksCompat("never follows a symlinked contracts-compat or fixture directory", () => {
    rmSync(join(dir, "source/contracts-compat"), { recursive: true, force: true });
    put("decoy/pos-supported.yaml", "x: y\n");
    symlinkSync(join(dir, "decoy"), join(dir, "source/contracts-compat"));
    expectRefused(/contracts-compat in the release commit is not a real directory/);
    rmSync(join(dir, "source/contracts-compat"));
    writeMatrix();
    put("decoy2/recorded.yaml", "provenance: recorded\n");
    mkdirSync(join(dir, "source/contracts-compat/replay"), { recursive: true });
    symlinkSync(join(dir, "decoy2"), join(dir, `source/contracts-compat/replay/${snapshotOf(BUILD_A)}`));
    expectRefused(/replay fixtures for pos-build-9dfd7d977267 are unreadable/);
  });

  it("judges the repository's real matrix with contracts-compat's own parser and freshness rule", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readFileSync } from "node:fs";
         import { FRESHNESS_DAYS, snapshotId } from "./contracts-compat/lib/evaluate.mjs";
         import { parseYamlSubset } from "./contracts-compat/lib/yaml-subset.mjs";
         const m = parseYamlSubset(readFileSync("contracts-compat/pos-supported.yaml", "utf8"));
         console.log(JSON.stringify({ FRESHNESS_DAYS, captured: m.fleet_baseline.captured_at, ids: m.supported.map(snapshotId) }));`,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(probe.status).toBe(0);
    const real = JSON.parse(probe.stdout) as { FRESHNESS_DAYS: number; captured: string; ids: string[] };
    expect(real.FRESHNESS_DAYS).toBe(7);
    const evalSrc = read("contracts-compat/lib/evaluate.mjs");
    expect(evalSrc).toContain("const MAX_CLOCK_SKEW_DAYS = 1 / 24;");
    expect(gate.MAX_CLOCK_SKEW_DAYS).toBe(1 / 24);
    // the repository's real matrix, judged the day after it was captured
    const day = new Date(Date.parse(real.captured) + 86_400_000);
    const result = gate.evaluateCompat(repoRoot, day);
    expect(result.problems).toEqual([]);
    const unrecorded = real.ids.join(", ");
    expect(result.mode === "release" || result.notes.join("\n").includes(unrecorded)).toBe(true);
    expect(result.notes.join("\n")).toContain(real.captured);
  });

  it("runs as the release guard's CLI: exit 0 on pass, 1 on refusal, 2 on usage", () => {
    const source = join(dir, "source");
    expect(gate.main(["--source", source])).toBe(0);
    writeMatrix({ capturedAt: daysAgo(30) });
    expect(gate.main(["--source", source])).toBe(1);
    expect(gate.main(["--source", source, "--now", daysAgo(29)])).toBe(0);
    expect(gate.main([])).toBe(2);
    expect(gate.main(["--source", source, "--now", "not-a-date"])).toBe(2);
  });
});

describe("verify-release: current release, schema and rollback", () => {
  it("plans an app-only rollback when the schema is unchanged", () => {
    writeCurrent(MIGRATIONS);
    const { refusals, ledger } = helper.evaluate(dir, ctx({ currentRelease: OLD_TAG }));
    expect(refusals).toEqual([]);
    expect(ledger.plan.migrations).toMatchObject({ added: [], removed: [], rollback: { allowed: true } });
  });

  it("refuses rolling back past an added migration (no automatic database downgrade)", () => {
    writeCurrent(UP.slice(0, 1));
    const { refusals, ledger } = helper.evaluate(dir, ctx({ currentRelease: OLD_TAG }));
    expect(refusals).toEqual([]);
    expect(ledger.plan.migrations).toMatchObject({ added: ["0002_sales.sql"], rollback: { allowed: false } });
    expect(helper.assessRollback(["0002_sales.sql"], [])).toMatchObject({ allowed: false, reason: expect.stringMatching(/restore or forward-fix/) });
  });

  it("refuses deploying, and rolling back, past a migration edited in place (same name, new content)", () => {
    writeCurrent(MIGRATIONS, { "packages/db/drizzle/0002_sales.sql": "f".repeat(40) });
    const { refusals, ledger } = helper.evaluate(dir, ctx({ currentRelease: OLD_TAG }));
    // migrate.ts tracks applied migrations by id only, so an edited applied migration never re-runs
    expect(refusals).toEqual(["target release edits 1 applied migration(s) in place: the migrator will not re-apply them"]);
    expect(ledger.plan.migrations).toMatchObject({ added: [], removed: [], changed: ["0002_sales.sql"], rollback: { allowed: false } });
  });

  it("refuses a migration list that is not git ls-tree output with blob IDs", () => {
    put("migrations-target.txt", MIGRATIONS.join("\n"));
    expectRefused(/target migration list missing, empty or not git ls-tree output/);
  });

  it("refuses deploying a release that lacks a migration the host already has", () => {
    writeCurrent([...MIGRATIONS, "packages/db/drizzle/0003_newer.sql"]);
    expectRefused(/schema downgrade is never automatic/, ctx({ currentRelease: OLD_TAG }));
  });

  it("refuses a current release that is not an immutable release with its evidence", () => {
    expectRefused(/current release metadata missing/, ctx({ currentRelease: OLD_TAG }));
    expectRefused(/current release migration list missing/, ctx({ currentRelease: OLD_TAG }));
  });

  it("still writes the summary when the current release evidence is missing", () => {
    const out = join(dir, "out");
    const argv = ["--evidence", dir, "--out", out, "--release", TAG, "--jira-key", "RT-703", "--target", "lab-01", "--mode", "dry-run", "--current-release", OLD_TAG];
    expect(helper.main(argv)).toBe(1);
    const summary = readFileSync(join(out, "summary.md"), "utf8");
    expect(summary).toContain("### Refused");
    expect(summary).toContain("no verified current release");
  });

  it("summarises the schema plan against a verified current release", () => {
    writeCurrent(UP.slice(0, 1));
    const { ledger } = helper.evaluate(dir, ctx({ currentRelease: OLD_TAG }));
    expect(helper.renderSummary(ledger)).toContain(`1 added and 0 edited in place since ${OLD_TAG} (operator-asserted, not host-verified)`);
  });
});

describe("verify-release: live mode and deployment identity", () => {
  it("refuses live mode without a deployment identity", () => {
    expectRefused(/no deployment identity/, ctx({ mode: "live" }));
    expectRefused(/live execution is not implemented/, ctx({ mode: "live" }));
  });

  it.each([
    ["the account root", { roleArn: "arn:aws:iam::431988153035:root", ssmNodeId: `mi-${"0".repeat(17)}`, environmentReviewers: 1 }, /IAM role ARN/],
    ["an IAM user", { roleArn: "arn:aws:iam::431988153035:user/deployer", ssmNodeId: `mi-${"0".repeat(17)}`, environmentReviewers: 1 }, /IAM role ARN/],
    ["an unregistered host", { roleArn: "arn:aws:iam::431988153035:role/lab-deploy", ssmNodeId: "i-0123", environmentReviewers: 1 }, /SSM managed node/],
    ["no required reviewer", { roleArn: "arn:aws:iam::431988153035:role/lab-deploy", ssmNodeId: `mi-${"0".repeat(17)}`, environmentReviewers: 0 }, /required reviewer|at least one reviewer/],
  ])("refuses a deployment identity using %s", (_label, identity, pattern) => {
    expect(helper.checkTransport(identity)).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });

  it("still refuses live mode with a well-formed identity, because slice 1 has no live path", () => {
    const transport = { roleArn: "arn:aws:iam::431988153035:role/lab-deploy", ssmNodeId: `mi-${"0".repeat(17)}`, environmentReviewers: 1 };
    expect(helper.checkTransport(transport)).toEqual([]);
    expect(refusalsOf(ctx({ mode: "live", transport }))).toEqual(["live execution is not implemented in RT-703 slice 1 (dry run only)"]);
  });
});

describe("verify-release: review hardening", () => {
  it("refuses a git tag that does not point at the release commit, or a missing tag", () => {
    put("tag-commit.txt", `${OLD_SHA}\n`);
    expectRefused(/release git tag does not point at/);
    rmSync(join(dir, "tag-commit.txt"));
    expectRefused(/release git tag does not point at .*resolves to 'nothing'/);
  });

  it("refuses release metadata for another tag, or no release metadata at all", () => {
    putJson("release.json", { tagName: OLD_TAG, targetCommitish: SHA, isDraft: false, isPrerelease: false, isImmutable: true });
    expectRefused(/release tag is 'backend-core-ff9e68331415'/);
    rmSync(join(dir, "release.json"));
    expectRefused(/release metadata missing or not JSON/);
  });

  it("refuses an ahead compare that still reports commits off main", () => {
    putJson("compare.json", { status: "ahead", ahead_by: 2, behind_by: 1, merge_base: SHA });
    expectRefused(/1 commit\(s\) that are not on main/);
  });

  it("accepts a newer success after an older failure (latest run wins)", () => {
    const runs = helper.REQUIRED_CHECKS.flatMap((name) => [
      { name, conclusion: "failure", slug: "github-actions", started_at: "2026-10-18T09:00:00Z" },
      { name, conclusion: "success", slug: "github-actions", started_at: "2026-10-18T10:00:00Z" },
    ]);
    putJson("check-runs.json", runs);
    expect(refusalsOf()).toEqual([]);
  });

  it("puts an early collection stop first in the ledger, so a checksum refusal is still recorded", () => {
    put("collect-error.txt", "release assets do not match SHA256SUMS\n");
    rmSync(join(dir, "bundle"), { recursive: true });
    const { refusals, ledger } = helper.evaluate(dir, ctx());
    expect(refusals[0]).toBe("evidence collection refused: release assets do not match SHA256SUMS");
    expect(ledger.outcome).toBe("refused");
    expect(ledger.failureBoundary).toBe(refusals[0]);
    expect(helper.renderSummary(ledger)).toContain("evidence collection refused: release assets do not match SHA256SUMS");
  });

  it("refuses a bundled file that differs from the release commit, even with self-consistent hashes", () => {
    writeRelease({ ...bundleFiles(), "docker-compose.release.yml": "services: { injected: {} }\n" });
    expectRefused(/bundled 'docker-compose.release.yml' does not match the release commit/);
  });

  it("refuses a bundled file that is not in the release commit, or missing source evidence", () => {
    writeSource({ "docker-compose.release.yml": bundleFiles()["docker-compose.release.yml"] ?? "" });
    expectRefused(/bundled 'docs\/operations\/sql\/cashier-admissions-domain-grants.sql' is not in the release commit/);
    rmSync(join(dir, "source"), { recursive: true });
    expectRefused(/release source evidence missing/);
  });

  it("refuses a bundle that leaves out a file the release commit's allowlist requires", () => {
    const files = bundleFiles();
    writeSource(files, [...Object.keys(files).filter((f) => f !== "release.env"), "Caddyfile"]);
    put("source/Caddyfile", ":443 {}\n");
    expectRefused(/release bundle lacks 'Caddyfile', which the release commit's allowlist requires/);
  });

  it("refuses a bundled file that is not in the release commit's allowlist", () => {
    writeSource(bundleFiles(), ["docker-compose.release.yml", "docs/operations/sql/erpnext-posting-resolution-catchup.sql"]);
    expectRefused(/bundled 'docs\/operations\/sql\/cashier-admissions-domain-grants.sql' is not in the release allowlist/);
  });

  it("accepts the routine grant scripts release-bundle.sh appends from the selector (RT-812)", () => {
    const files = bundleFiles();
    const grant = "docs/operations/sql/cashier-admissions-domain-grants.sql";
    writeSource(files, Object.keys(files).filter((f) => f !== "release.env" && f !== grant));
    const bundleScript = join(dir, "source/deploy/release-bundle.sh");
    put("source/deploy/release-bundle.sh", `${readFileSync(bundleScript, "utf8")}ROUTINE_GRANTS="$(bash deploy/apply-domain-grants.sh --list)"\n`);
    // Unmarked, the bundled grant script is not in the release allowlist.
    expectRefused(/bundled 'docs\/operations\/sql\/cashier-admissions-domain-grants.sql' is not in the release allowlist/);
    // Marked, the selector lists it and the bundle is complete.
    writeRelease({ ...files, [grant]: `-- deploy: every-release\n${files[grant] ?? ""}` });
    put(`source/${grant}`, `-- deploy: every-release\n${files[grant] ?? ""}`);
    expect(refusalsOf().filter((r) => /allowlist|lacks/.test(r))).toEqual([]);
    // A marked script the bundle leaves out is refused.
    put("source/docs/operations/sql/zz-new-domain-grants.sql", "-- deploy: every-release\n");
    expectRefused(/release bundle lacks 'docs\/operations\/sql\/zz-new-domain-grants.sql'/);
  });

  it("refuses when the release commit has no release allowlist to check against", () => {
    rmSync(join(dir, "source/deploy/release-bundle.sh"));
    expectRefused(/release allowlist missing or unreadable at the release commit/);
  });

  it("refuses, and still writes the ledger, when a bundle directory cannot be read", () => {
    const realReaddir = nodeFs.readdirSync;
    jest.spyOn(nodeFs, "readdirSync").mockImplementation(((p: string, opts: unknown) => {
      if (String(p).includes(join("bundle", BUNDLE, "docs"))) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return (realReaddir as (p: string, o: unknown) => unknown)(p, opts);
    }) as typeof nodeFs.readdirSync);
    const out = join(dir, "out");
    expect(helper.main(["--evidence", dir, "--out", out, "--release", TAG, "--jira-key", "RT-703", "--target", "lab-01", "--mode", "dry-run"])).toBe(1);
    const ledger = JSON.parse(readFileSync(join(out, "ledger.json"), "utf8")) as Ledger;
    expect(ledger.refusals).toContain("bundle directory 'docs' cannot be read (EACCES)");
  });

  it("refuses, and never reads, a bundled file over the size limit (e.g. a sparse member)", () => {
    const file = join(dir, `bundle/${BUNDLE}/release.env`);
    nodeFs.truncateSync(file, 17 * 1024 * 1024);
    const readSpy = jest.spyOn(nodeFs, "readFileSync");
    expectRefused(/bundle entry 'release.env' is larger than 16777216 bytes/);
    expect(readSpy.mock.calls.some(([p]) => String(p) === file)).toBe(false);
  });

  it("refuses a duplicate SHA256SUMS entry", () => {
    const sumsFile = join(dir, "release/SHA256SUMS");
    const first = readFileSync(sumsFile, "utf8").split("\n")[0] ?? "";
    put("release/SHA256SUMS", `${readFileSync(sumsFile, "utf8")}${first}\n`);
    expectRefused(/release SHA256SUMS: duplicate entry/);
  });

  it.each([
    ["repository", { repository: "Kemetra/Other" }, /manifest repository is 'Kemetra\/Other'/],
    ["releaseTag", { releaseTag: OLD_TAG }, /manifest releaseTag 'backend-core-ff9e68331415'/],
  ])("refuses a manifest with another %s", (_label, over, pattern) => {
    const files = bundleFiles();
    writeRelease(files, { ...manifest(files), ...over });
    expectRefused(pattern);
  });

  it("refuses a manifest that is not JSON", () => {
    put("release/release-manifest.json", "not json");
    expectRefused(/release manifest missing or not JSON/);
  });

  it("refuses a manifest whose file list leaves out release.env", () => {
    const files = bundleFiles();
    const { "release.env": _env, ...listed } = files;
    const m = manifest(listed);
    writeRelease(files, m);
    // release.env is still on disk, but neither listed nor hashed
    expectRefused(/manifest file list does not include release.env/);
    expectRefused(/bundle has an unlisted file 'release.env'/);
  });

  it("refuses an unlisted file in the extracted bundle", () => {
    put(`bundle/${BUNDLE}/docs/operations/sql/extra-domain-grants.sql`, "grant all;\n");
    expectRefused(/bundle has an unlisted file 'docs\/operations\/sql\/extra-domain-grants.sql'/);
  });

  it("refuses a bundle entry that is not a regular file, and never reads through it", () => {
    rmSync(join(dir, `bundle/${BUNDLE}/release.env`));
    mkdirSync(join(dir, `bundle/${BUNDLE}/release.env`));
    expectRefused(/'release.env' missing or not a regular file/);
    expectRefused(/bundle release.env missing or not a regular file/);
  });

  // Creating a symlink needs privileges on Windows; CI (Linux) always runs this case.
  const itWithSymlinks = process.platform === "win32" ? it.skip : it;
  itWithSymlinks("refuses a symlink in the bundle instead of following it", () => {
    put("secret.json", '{"auths":{"ghcr.io":{"auth":"c2VjcmV0"}}}');
    rmSync(join(dir, `bundle/${BUNDLE}/release.env`));
    symlinkSync(join(dir, "secret.json"), join(dir, `bundle/${BUNDLE}/release.env`));
    const refusals = refusalsOf();
    expect(refusals).toEqual(expect.arrayContaining([expect.stringMatching(/bundle entry 'release.env' is not a regular file/)]));
    expect(refusals.join("\n")).not.toContain("c2VjcmV0");
  });

  it("never echoes a raw release.env line that is not KEY=value", () => {
    const files = { ...bundleFiles(), "release.env": `${bundleFiles()["release.env"]}{"auths":{"ghcr.io":{"auth":"c2VjcmV0"}}}\n` };
    writeRelease(files);
    const refusals = refusalsOf();
    expect(refusals).toContain("release.env line 5 is not a plain KEY=<digest ref> assignment");
    expect(refusals.join("\n")).not.toContain("c2VjcmV0");
  });

  it.each([
    ["an empty result", []],
    ["a non-SLSA predicate", [{ verificationResult: { statement: { predicateType: "https://example.test/other", subject: [{ digest: { sha256: "c".repeat(64) } }] }, signature: { certificate: { sourceRepositoryDigest: SHA, sourceRepositoryRef: "refs/heads/main", buildSignerURI: helper.SIGNER_WORKFLOW } } } }]],
  ])("refuses an attestation with %s", (_label, value) => {
    putJson("attest-migrate.json", value);
    expectRefused(/(no verified attestation for the migrate image|migrate attestation does not bind)/);
  });

  it("counts only forward migrations, not their .down.sql companions", () => {
    expect(helper.evaluate(dir, ctx()).ledger.plan.migrations?.targetCount).toBe(UP.length);
  });

  it("refuses a current release that is not reachable from main or whose tag moved", () => {
    writeCurrent(MIGRATIONS);
    putJson("compare-current.json", { status: "diverged", ahead_by: 1, behind_by: 4, merge_base: SHA });
    put("current-tag-commit.txt", `${SHA}\n`);
    const c = ctx({ currentRelease: OLD_TAG });
    expectRefused(/current release SHA is not reachable from main/, c);
    expectRefused(/current release git tag does not point at/, c);
    // an unverified current release never feeds the rollback plan
    expect(helper.evaluate(dir, c).ledger.plan.migrations?.added).toBeNull();
  });

  it("escapes release-derived text in the Markdown summary", () => {
    put("release/release-manifest.json", JSON.stringify({ repository: "[click](https://evil.test) <img src=x> | ![x](y)" }));
    const summary = helper.renderSummary(helper.evaluate(dir, ctx()).ledger);
    expect(summary).not.toMatch(/(^|[^\\])\[click\]/);
    expect(summary).not.toMatch(/(^|[^\\])<img/);
    expect(summary).toContain("\\[click\\]\\(https://evil.test\\)");
  });
});
