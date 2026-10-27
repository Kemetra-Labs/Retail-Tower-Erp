/**
 * RT-703 + RT-842, ported in RT-908 — the manual lab deploy workflow at the
 * monorepo root (.github/workflows/deploy-lab.yml): a read-only preflight, and
 * the live job that runs only for dry_run=false. The checks are static, except
 * the guard, variable and plan checks, which run the real step scripts with
 * bash. The offline release verifier it calls is covered by deploy-lab.spec.ts.
 *
 * RT-908 (roadmap v3, Phase A): the releases are still published by the frozen
 * Kemetra/Backend-Core, so every piece of release evidence, including the git
 * objects of the release commit, is read from that repository, never from this
 * monorepo's rewritten history. The aws-lab environment is this repository's.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as yaml from "js-yaml";

// services/backend-core, and the monorepo root above it.
const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const monorepoRoot = resolve(repoRoot, "..", "..");
// Normalise CRLF so checkouts with core.autocrlf behave like CI.
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");
const readRoot = (rel: string): string => readFileSync(resolve(monorepoRoot, rel), "utf8").replace(/\r\n/g, "\n");

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: unknown;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Input = { required?: boolean; type?: string; default?: unknown; options?: string[] };
type Workflow = {
  on: Record<string, { inputs: Record<string, Input> }>;
  permissions: unknown;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};

const RELEASE_REPO = "Kemetra/Backend-Core";
const workflowText = readRoot(".github/workflows/deploy-lab.yml");
const workflow = yaml.load(workflowText) as Workflow;
const jobs = Object.entries(workflow.jobs);
const preflight = workflow.jobs.preflight as Job;
const live = workflow.jobs.live as Job;
const allSteps = jobs.flatMap(([, job]) => job.steps);
const preflightSteps = preflight.steps;
const scripts = preflightSteps.map((s) => s.run ?? "").join("\n");
const liveScripts = live.steps.map((s) => s.run ?? "").join("\n");
function stepIndex(prefix: string, steps: Step[] = preflightSteps): number {
  const i = steps.findIndex((s) => (s.name ?? "").startsWith(prefix));
  if (i < 0) throw new Error(`workflow step missing: ${prefix}`);
  return i;
}
function stepNamed(prefix: string, steps: Step[] = preflightSteps): Step {
  const found = steps.find((s) => (s.name ?? "").startsWith(prefix));
  if (!found) throw new Error(`workflow step missing: ${prefix}`);
  return found;
}

const SHA = "1711813df1f36d7ed60db1096f9a23c2be1e81c3";
const DIGESTS: Record<string, string> = {
  api: `sha256:${"a".repeat(64)}`,
  worker: `sha256:${"b".repeat(64)}`,
  migrate: `sha256:${"c".repeat(64)}`,
};

// The guard scripts are run for real with bash (CI is Linux; locally only when bash works).
function bashWorks(): boolean {
  const probe = spawnSync("bash", ["-c", "printf ok"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout === "ok";
}
const haveBash = bashWorks();
if (!haveBash && process.env["CI"]) throw new Error("bash is required in CI for the deploy-lab guard checks");
const itBash = haveBash ? it : it.skip;
/** Runs one workflow step's script with only the given variables (plus PATH), as Actions would. */
function runStep(step: Step, env: Record<string, string>): { status: number | null; output: string } {
  const r = spawnSync("bash", ["-c", step.run ?? ""], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", ...env } });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describe("deploy-lab workflow", () => {
  it("is manual only, with release, Jira key, lab-01 target and a dry run that defaults on", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    expect(inputs.backend_release).toMatchObject({ required: true, type: "string" });
    expect(inputs.jira_key).toMatchObject({ required: true, type: "string" });
    expect(inputs.target).toMatchObject({ type: "choice", options: ["lab-01"] });
    expect(inputs.current_release).toMatchObject({ required: false, type: "string" });
    expect(inputs.dry_run).toMatchObject({ type: "boolean", default: true });
  });

  it("holds one run at a time without cancelling a running one", () => {
    expect(workflow.concurrency).toEqual({ group: "deploy-aws-lab", "cancel-in-progress": false });
  });

  it("has exactly the preflight and the live job", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["preflight", "live"]);
  });

  it("grants nothing at the top level; the preflight is read-only, and only the live job has id-token", () => {
    expect(workflow.permissions).toEqual({});
    expect(preflight.permissions).toBeDefined();
    expect(Object.values(preflight.permissions ?? {}).every((v) => v === "read")).toBe(true);
    expect(preflight.permissions).not.toHaveProperty("id-token");
    expect(live.permissions).toEqual({ contents: "read", "id-token": "write" });
    // the one write scope in the file is the live job's id-token
    expect([...workflowText.matchAll(/^\s+[\w-]+:\s*write\b/gm)].map((m) => m[0].trim())).toEqual(["id-token: write"]);
  });

  it("names the aws-lab environment only in the live job, which never runs for a dry run", () => {
    expect(preflight).not.toHaveProperty("environment");
    expect(live.environment).toBe("aws-lab");
    expect(live.needs).toBe("preflight");
    expect(live.if).toBe("${{ inputs.dry_run == false }}");
  });

  it("guards first in both jobs, main ref and validated inputs", () => {
    expect(preflight.if).toBeUndefined();
    for (const [, job] of jobs) {
      const guard = job.steps[0];
      expect(guard?.name).toMatch(/^Guard/);
      expect(guard?.env?.RUN_REF).toBe("${{ github.ref }}");
      const run = guard?.run ?? "";
      expect(run).toContain('[ "$RUN_REF" = "refs/heads/main" ] || fail "must be dispatched from refs/heads/main"');
      expect(run).toContain("^backend-core-[0-9a-f]{12}$");
      expect(run).toContain('[ "$TARGET" = "lab-01" ]');
    }
    expect(live.steps[0]?.run).toContain('[ "$DRY_RUN" = "false" ] || fail');
  });

  it("pins every action to a commit SHA and checks out without credentials or a ref", () => {
    const uses = allSteps.map((s) => s.uses).filter((u): u is string => typeof u === "string");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    for (const step of allSteps.filter((s) => s.uses?.startsWith("actions/checkout@"))) {
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(step.with).not.toHaveProperty("ref");
    }
  });

  it("checks out only this repository (the tooling) and, read-only, the release source in Kemetra/Backend-Core", () => {
    for (const [, job] of jobs) {
      const checkouts = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkouts.map((s) => s.name)).toEqual(["Checkout main", "Checkout the release source (Kemetra/Backend-Core, read-only)"]);
      const [tooling, source] = checkouts;
      expect(tooling?.with).not.toHaveProperty("repository");
      expect(tooling?.with).not.toHaveProperty("path");
      expect(source?.with).toMatchObject({ repository: RELEASE_REPO, path: "release-source", "persist-credentials": false, "fetch-depth": 0 });
    }
    expect(stepNamed("Checkout the release source")).toMatchObject({ id: "release_source" });
    expect(stepIndex("Checkout main")).toBeLessThan(stepIndex("Checkout the release source"));
    expect(stepIndex("Checkout the release source")).toBeLessThan(stepIndex("Collect release evidence"));
  });

  it("reads release evidence from Kemetra/Backend-Core and the aws-lab environment from this repository", () => {
    const collect = stepNamed("Collect release evidence");
    expect(collect.env?.REPO).toBe(RELEASE_REPO);
    expect(collect.env?.ENV_REPO).toBe("${{ github.repository }}");
    expect(collect.env?.SRC).toBe("${{ github.workspace }}/release-source");
    const run = String(collect.run);
    expect(run).toContain('gh release view "$BACKEND_RELEASE" --repo "$REPO"');
    expect(run).toContain('gh api "repos/$REPO/compare/$SHA...main"');
    expect(run).toContain('gh api --paginate "repos/$REPO/commits/$SHA/check-runs?per_page=100"');
    expect(run).toContain('gh api "repos/$ENV_REPO/environments/aws-lab"');
    expect(run).not.toContain("repos/$REPO/environments");
    // `github.repository` (the monorepo) never stands in for the release repository
    expect(workflowText).not.toMatch(/^\s+REPO: \$\{\{ github\.repository \}\}/m);
  });

  it("runs every git command against a checkout of the release source, never the monorepo's rewritten history", () => {
    const code = `${scripts}\n${liveScripts}`
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const gitCalls = [...code.matchAll(/(^|[\s(|;&`])git\s+(\S+)/gm)].map((m) => m[2]);
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const arg of gitCalls) expect(arg).toBe("-C");
    expect(scripts).toContain('git -C "$SRC" rev-parse --verify --quiet "refs/tags/$BACKEND_RELEASE^{commit}"');
    expect(liveScripts).toContain('git -C "$RELEASE_REPO_DIR" -c core.autocrlf=false archive --format=tar "$RELEASE_SHA" contracts-compat');
    // the imported monorepo tags (backend-core/backend-core-<sha12>) point at rewritten commits
    expect(workflowText).not.toContain("refs/tags/backend-core/");
  });

  it("calls the deploy tooling at its monorepo path", () => {
    for (const tool of ["deploy/lab/verify-release.cjs", "deploy/release-compat-gate.cjs", "deploy/lab/oidc-claims-check.cjs"]) {
      expect(workflowText).toContain(`node services/backend-core/${tool}`);
      expect(read(tool).length).toBeGreaterThan(0);
    }
    expect(workflowText).not.toMatch(/node deploy\//);
  });

  it("never interpolates expressions inside run scripts (inputs reach the shell via env only)", () => {
    for (const step of allSteps) if (step.run !== undefined) expect(step.run).not.toContain("${{");
  });

  it("uses no secret but the read-only GITHUB_TOKEN, and no AWS key anywhere", () => {
    const secrets = [...workflowText.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect(secrets.length).toBeGreaterThan(0);
    expect(new Set(secrets)).toEqual(new Set(["GITHUB_TOKEN"]));
    expect(workflowText).not.toMatch(/aws-access-key-id|aws-secret-access-key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);
  });

  it("the preflight deploys nothing: no AWS, SSH, SSM, remote execution, compose or image pulls", () => {
    for (const step of preflightSteps) {
      expect(step.uses ?? "").not.toMatch(/aws|ssh|deploy|kubectl|appleboy/i);
      // command words only: "aws-lab" (the environment name) is not the aws CLI
      expect(step.run ?? "").not.toMatch(/(^|[\s;&|(])(aws|ssh|scp|ssm|kubectl|appleboy)\s/im);
      expect(step.run ?? "").not.toMatch(/docker\s+(compose|pull|run|push)|compose\s+up|send-command/i);
    }
    expect(workflowText).not.toMatch(/latest/i);
  });

  it("verifies the checksums before unpacking, and every image attestation against main and the release SHA", () => {
    expect(scripts.indexOf("sha256sum --check --strict SHA256SUMS")).toBeGreaterThan(-1);
    expect(scripts.indexOf("sha256sum --check --strict SHA256SUMS")).toBeLessThan(scripts.indexOf("tar -xzf"));
    expect(scripts).toContain("for TARGET in api worker migrate; do");
    expect(scripts).toContain('--signer-workflow "$REPO/.github/workflows/release-images.yml"');
    expect(scripts).toContain('--source-digest "$SHA"');
    expect(scripts).toContain("--source-ref refs/heads/main");
    expect(scripts).toContain("compare/$SHA...main");
  });

  it("decides in the verifier, in dry-run mode, and always publishes the ledger", () => {
    expect(scripts).toContain("node services/backend-core/deploy/lab/verify-release.cjs");
    expect(scripts).toContain("--mode dry-run");
    expect(workflowText).not.toContain("--mode live");
    for (const upload of allSteps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"))) expect(upload.if).toBe("always()");
  });

  it("runs every shell step with set -euo pipefail, paginates check runs and fetches the release source's full history", () => {
    for (const step of allSteps) if (step.run !== undefined) expect(step.run.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(scripts).toContain("gh api --paginate");
    expect(stepNamed("Checkout the release source").with?.["fetch-depth"]).toBe(0);
  });

  it("only unpacks a tarball covered by SHA256SUMS that holds plain files under one directory", () => {
    const at = (needle: string): number => {
      const i = scripts.indexOf(needle);
      expect({ needle, found: i > -1 }).toEqual({ needle, found: true });
      return i;
    };
    const extract = at("tar -xzf");
    expect(at("SHA256SUMS must list exactly")).toBeLessThan(extract);
    expect(at("sha256sum --check --strict")).toBeLessThan(extract);
    expect(at('[[ "$TYPES" =~ ^[-d]+$ ]]')).toBeLessThan(extract);
    expect(at('case "$ENTRY" in "$BUNDLE"/*)')).toBeLessThan(extract);
    // only the three expected assets, each size-checked from metadata, are ever downloaded
    const download = at('gh release download "$BACKEND_RELEASE"');
    expect(at("--json tagName,targetCommitish,isDraft,isPrerelease,isImmutable,assets")).toBeLessThan(download);
    expect(at("release assets are not exactly")).toBeLessThan(download);
    expect(at('--pattern "$BUNDLE.tar.gz" --pattern release-manifest.json --pattern SHA256SUMS')).toBeGreaterThan(download);
    // SHA256SUMS must name exactly the two assets, so sha256sum never opens anything else (e.g. /dev/zero)
    expect(at("SHA256SUMS must list exactly")).toBeLessThan(at("sha256sum --check --strict"));
    // sparse members: the logical sizes tar reports are capped too, with numeric owners so columns cannot shift
    expect(at('tar -tvzf "$TARBALL" --numeric-owner')).toBeLessThan(extract);
    expect(at('[ "$LOGICAL" -le "$MAX_BUNDLE_BYTES" ] || fail')).toBeLessThan(extract);
    // a gzip bomb is stopped by a bounded decompress before any tar call reads the archive
    const bounded = at('gzip -dc "$TARBALL" | head -c "$((MAX_BUNDLE_BYTES + 1))" | wc -c');
    expect(bounded).toBeLessThan(at("tar -tvzf"));
    expect(at('[ "$EXPANDED" -le "$MAX_BUNDLE_BYTES" ] || fail')).toBeLessThan(at("tar -tvzf"));
    expect(at('[ "$(wc -l <<<"$ENTRIES")" -le "$MAX_BUNDLE_ENTRIES" ] || fail')).toBeLessThan(extract);
    expect(at("unsafe bundle entry path")).toBeLessThan(extract);
    expect(at("refs/tags/$BACKEND_RELEASE^{commit}")).toBeGreaterThan(-1);
  });

  it("records early collection stops as evidence and still runs the verifier, but never after a failed guard", () => {
    const collect = String(stepNamed("Collect release evidence").run);
    expect(collect).toContain('echo "$*" >> "$EVIDENCE/collect-error.txt"; exit 1; }');
    expect(collect).toMatch(/trap '.*collect-error\.txt"' ERR/);
    expect(collect).toContain('|| fail "release assets do not match SHA256SUMS"');
    // RT-908: a failed release-source checkout stops the verifier, as the full-history checkout did before.
    expect(stepNamed("Verify evidence").if).toBe(
      "${{ !cancelled() && steps.guard.outcome == 'success' && steps.checkout.outcome == 'success' && steps.release_source.outcome == 'success' && steps.logout.outcome == 'success' }}",
    );
    expect(stepNamed("Guard")).toMatchObject({ id: "guard" });
    expect(stepNamed("Checkout main")).toMatchObject({ id: "checkout" });
  });

  it("records migration blob IDs, not only names, for the target and current releases", () => {
    const collect = String(stepNamed("Collect release evidence").run);
    expect(collect).toContain('git -C "$SRC" ls-tree "$SHA" packages/db/drizzle/ > "$EVIDENCE/migrations-target.txt"');
    expect(collect).toContain('git -C "$SRC" ls-tree "$CURRENT_SHA" packages/db/drizzle/ > "$EVIDENCE/migrations-current.txt"');
    expect(collect).not.toContain("ls-tree --name-only");
  });

  it("logs out of GHCR however collection ended, and verifies only after a successful logout", () => {
    const order = ["Collect release evidence", "Log out of GHCR", "Verify evidence"].map((p) => stepIndex(p));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const logout = stepNamed("Log out of GHCR");
    expect(logout).toMatchObject({ id: "logout", if: "always()" });
    expect(logout.run).toContain("docker logout ghcr.io");
    expect(stepNamed("Verify evidence").if).toContain("steps.logout.outcome == 'success'");
  });

  it("records the release commit's tree so bundled files can be bound to it", () => {
    expect(String(stepNamed("Collect release evidence").run)).toContain(
      'git -C "$SRC" -c core.autocrlf=false archive --format=tar "$SHA" | tar -x -C "$EVIDENCE/source"',
    );
  });
});

describe("deploy-lab workflow: preflight guard (RT-842)", () => {
  const guard = (): Step => stepNamed("Guard");
  const env = (over: Record<string, string> = {}): Record<string, string> => ({
    RUN_REF: "refs/heads/main",
    BACKEND_RELEASE: "backend-core-1711813df1f3",
    JIRA_KEY: "RT-842",
    TARGET: "lab-01",
    CURRENT_RELEASE: "",
    DRY_RUN: "true",
    ...over,
  });

  itBash("passes a dry run with or without current_release", () => {
    expect(runStep(guard(), env()).status).toBe(0);
    expect(runStep(guard(), env({ CURRENT_RELEASE: "backend-core-046b7f7cff53" })).status).toBe(0);
  });

  itBash("lets a live run through only with current_release (G-Prov)", () => {
    const missing = runStep(guard(), env({ DRY_RUN: "false" }));
    expect(missing.status).not.toBe(0);
    expect(missing.output).toContain("a live run (dry_run=false) needs current_release");
    expect(runStep(guard(), env({ DRY_RUN: "false", CURRENT_RELEASE: "backend-core-046b7f7cff53" })).status).toBe(0);
  });

  itBash.each([
    [{ RUN_REF: "refs/heads/feature" }, /must be dispatched from refs\/heads\/main/],
    [{ DRY_RUN: "maybe" }, /dry_run must be true or false/],
    [{ BACKEND_RELEASE: "backend-core-latest" }, /backend_release must be/],
    // a monorepo-style tag is Phase B; this workflow accepts only backend-core-<sha12>
    [{ BACKEND_RELEASE: "backend-core/v1.2.3" }, /backend_release must be/],
  ])("refuses %o", (over, pattern) => {
    const r = runStep(guard(), env(over));
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(pattern);
  });

  it("exports only a planned, 0-refusal plan to the live job", () => {
    const plan = stepNamed("Export the verified plan");
    expect(plan.id).toBe("plan");
    expect(plan.if).toBeUndefined();
    expect(stepIndex("Verify evidence")).toBeLessThan(stepIndex("Export the verified plan"));
    expect(plan.run).toContain('.outcome == "planned" and (.refusals | length) == 0');
    expect(plan.run).toContain(".plan.migrations.added != null and .plan.migrations.rollback.allowed == true");
    expect(Object.keys(preflight.outputs ?? {}).sort()).toEqual(["api_digest", "environment_gate", "migrate_digest", "release_sha", "rollback_allowed", "worker_digest"]);
  });

  describe("the aws-lab reviewer gate", () => {
    let tmp: string;
    const planEnv = (dryRun: string): Record<string, string> => ({
      DRY_RUN: dryRun,
      RUNNER_TEMP: tmp,
      GITHUB_OUTPUT: join(tmp, "output"),
    });
    const writeEvidence = (environment: unknown): void => {
      mkdirSync(join(tmp, "ledger"), { recursive: true });
      mkdirSync(join(tmp, "evidence"), { recursive: true });
      writeFileSync(
        join(tmp, "ledger", "ledger.json"),
        JSON.stringify({
          outcome: "planned",
          refusals: [],
          release: { sha: SHA },
          images: Object.fromEntries(Object.entries(DIGESTS).map(([t, digest]) => [t, { digest }])),
          plan: { migrations: { added: [], rollback: { allowed: true } } },
        }),
      );
      if (environment !== undefined) writeFileSync(join(tmp, "evidence", "environment.json"), JSON.stringify(environment));
    };
    const gateOutput = (): string => /environment_gate=(\w+)/.exec(readFileSync(join(tmp, "output"), "utf8"))?.[1] ?? "";
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "rt842-plan-"));
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    itBash("lets a live run through only when aws-lab was read back with a required reviewer", () => {
      writeEvidence({ status: "present", reviewers: 1 });
      expect(runStep(stepNamed("Export the verified plan"), planEnv("false")).status).toBe(0);
      expect(gateOutput()).toBe("reviewed");
    });

    itBash.each([
      ["not visible", { status: "not-visible", reviewers: 0 }],
      ["unknown", { status: "unknown", reviewers: 0 }],
      ["present without a reviewer", { status: "present", reviewers: 0 }],
      ["a non-numeric reviewer count", { status: "present", reviewers: "1" }],
      ["no environment evidence", undefined],
    ])("refuses a live run when the environment is %s", (_label, environment) => {
      writeEvidence(environment);
      const r = runStep(stepNamed("Export the verified plan"), planEnv("false"));
      expect(r.status).not.toBe(0);
      expect(r.output).toContain("live run refused: the aws-lab environment was not read back with a required reviewer");
      expect(gateOutput()).toBe("unverified");
    });

    itBash("never blocks a dry run on the environment", () => {
      writeEvidence({ status: "not-visible", reviewers: 0 });
      expect(runStep(stepNamed("Export the verified plan"), planEnv("true")).status).toBe(0);
      expect(gateOutput()).toBe("unverified");
    });
  });
});

describe("deploy-lab workflow: live job (RT-842)", () => {
  const order = (prefix: string): number => stepIndex(prefix, live.steps);
  const liveGuard = (): Step => stepNamed("Guard", live.steps);
  const varsCheck = (): Step => stepNamed("Check the deploy variables", live.steps);
  const ARN = "arn:aws:iam::431988153035:role/rt-gha-aws-lab-deploy";
  const guardEnv = (over: Record<string, string> = {}): Record<string, string> => ({
    RUN_REF: "refs/heads/main",
    DRY_RUN: "false",
    BACKEND_RELEASE: "backend-core-1711813df1f3",
    CURRENT_RELEASE: "backend-core-046b7f7cff53",
    JIRA_KEY: "RT-842",
    TARGET: "lab-01",
    RELEASE_SHA: SHA,
    API_DIGEST: DIGESTS.api ?? "",
    WORKER_DIGEST: DIGESTS.worker ?? "",
    MIGRATE_DIGEST: DIGESTS.migrate ?? "",
    ROLLBACK_ALLOWED: "true",
    ENVIRONMENT_GATE: "reviewed",
    ...over,
  });

  it("checks the guard, then the variables, before any token or credential step", () => {
    const steps = [
      "Guard",
      "Check the deploy variables",
      "Checkout main",
      "Checkout the release source",
      "Re-check the POS compat gate",
      "Print the OIDC claims",
      "Assume the deploy role",
      "Run the SSM gates",
      "Write the live ledger",
      "Upload the live ledger",
    ];
    expect(live.steps.map((s) => steps.findIndex((p) => (s.name ?? "").startsWith(p)))).toEqual(steps.map((_, i) => i));
  });

  // RT-863 (Codex P1 on #922): approval can arrive after the fleet baseline goes stale.
  it("re-runs the POS compat gate on the release commit after approval, before any credential", () => {
    const recheck = stepNamed("Re-check the POS compat gate", live.steps);
    expect(recheck.env?.RELEASE_SHA).toBe("${{ needs.preflight.outputs.release_sha }}");
    expect(recheck.env?.RELEASE_REPO_DIR).toBe("${{ github.workspace }}/release-source");
    expect(recheck.run).toContain("set -euo pipefail");
    expect(recheck.run).toContain('archive --format=tar "$RELEASE_SHA" contracts-compat');
    expect(recheck.run).toContain('node services/backend-core/deploy/release-compat-gate.cjs --source "$SRC"');
    expect(stepNamed("Checkout the release source", live.steps).with?.["fetch-depth"]).toBe(0);
    expect(order("Re-check the POS compat gate")).toBeLessThan(order("Assume the deploy role"));
    expect(order("Re-check the POS compat gate")).toBeLessThan(order("Run the SSM gates"));
  });

  it("takes the role and region only from the aws-lab variables, with a SHA-pinned configure-aws-credentials", () => {
    const assume = stepNamed("Assume the deploy role", live.steps);
    expect(assume.uses).toMatch(/^aws-actions\/configure-aws-credentials@[0-9a-f]{40}$/);
    expect(assume.with).toMatchObject({ "role-to-assume": "${{ vars.AWS_ROLE_ARN }}", "aws-region": "${{ vars.AWS_REGION }}" });
    expect(assume.with).not.toHaveProperty("aws-access-key-id");
    expect(varsCheck().env).toEqual({ AWS_ROLE_ARN: "${{ vars.AWS_ROLE_ARN }}", AWS_REGION: "${{ vars.AWS_REGION }}" });
    // the only `vars.` references are the variable check and the credentials step
    expect([...workflowText.matchAll(/vars\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(["AWS_REGION", "AWS_REGION", "AWS_ROLE_ARN", "AWS_ROLE_ARN"]);
  });

  itBash.each([
    ["both unset", {}, /AWS_ROLE_ARN is not set on the aws-lab environment/],
    ["the region unset", { AWS_ROLE_ARN: ARN }, /AWS_REGION is not set on the aws-lab environment/],
    ["the role unset", { AWS_REGION: "us-east-1" }, /AWS_ROLE_ARN is not set/],
    ["the account root", { AWS_ROLE_ARN: "arn:aws:iam::431988153035:root", AWS_REGION: "us-east-1" }, /must be an IAM role ARN/],
    ["an IAM user", { AWS_ROLE_ARN: "arn:aws:iam::431988153035:user/deployer", AWS_REGION: "us-east-1" }, /must be an IAM role ARN/],
    ["a malformed region", { AWS_ROLE_ARN: ARN, AWS_REGION: "us-east-1; id" }, /AWS_REGION must be a region name/],
  ])("fails closed with %s", (_label, env, pattern) => {
    const r = runStep(varsCheck(), env);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(pattern);
  });

  itBash("passes the variable check only with a role ARN and a region", () => {
    expect(runStep(varsCheck(), { AWS_ROLE_ARN: ARN, AWS_REGION: "us-east-1" }).status).toBe(0);
  });

  itBash.each([
    ["a non-main ref", { RUN_REF: "refs/heads/feature" }, /must be dispatched from refs\/heads\/main/],
    ["a dry run", { DRY_RUN: "true" }, /runs only when dry_run=false/],
    ["no current release", { CURRENT_RELEASE: "" }, /needs current_release/],
    ["a plan for another commit", { RELEASE_SHA: "ff9e68331415c29aa21ba3ece6af3e2f62b22646" }, /does not name the release commit/],
    ["a plan without digests", { WORKER_DIGEST: "" }, /lacks a registry digest/],
    ["a plan without the rollback rule", { ROLLBACK_ALLOWED: "" }, /lacks the rollback rule/],
    ["an unverified aws-lab reviewer gate", { ENVIRONMENT_GATE: "unverified" }, /did not read back aws-lab with a required reviewer/],
  ])("the live guard refuses %s", (_label, over, pattern) => {
    const r = runStep(liveGuard(), guardEnv(over));
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(pattern);
  });

  itBash("the live guard passes a verified live plan", () => {
    expect(runStep(liveGuard(), guardEnv()).status).toBe(0);
  });

  it("prints only allowlisted OIDC claims, masking the token, and never gates on them", () => {
    const claims = String(stepNamed("Print the OIDC claims", live.steps).run);
    expect(claims.indexOf('echo "::add-mask::$TOKEN"')).toBeLessThan(claims.indexOf("node services/backend-core/deploy/lab/oidc-claims-check.cjs"));
    expect(claims).toContain("--workflow-file deploy-lab.yml");
    expect(claims).toContain('|| echo "::warning::');
    expect(order("Print the OIDC claims")).toBeLessThan(order("Assume the deploy role"));
  });

  it("runs only the two RT documents, backup before deploy, with no shell document or session", () => {
    expect(liveScripts).not.toMatch(/AWS-RunShellScript|start-session|StartSession|ssh\s|scp\s/i);
    const docs = [...liveScripts.matchAll(/run_document (\w+) "\$\w+" ([\w-]+) /g)].map((m) => [m[1], m[2]]);
    expect(docs).toEqual([
      ["backup", "RT-BackendLabBackup"],
      ["deploy", "RT-BackendLabDeploy"],
    ]);
    expect([...liveScripts.matchAll(/aws ssm send-command/g)]).toHaveLength(1);
    expect([...liveScripts.matchAll(/aws ssm (\S+)/g)].map((m) => m[1])).toEqual(["describe-instance-information", "send-command", "get-command-invocation", "get-command-invocation"]);
    expect(liveScripts).toContain("--document-version '$DEFAULT'");
    // the deploy waits for a single, well-formed backup reference first
    expect(liveScripts.indexOf("backup: no single backup reference reported")).toBeLessThan(liveScripts.indexOf("run_document deploy"));
    expect(liveScripts).toContain('grep -qx "RT_DONE release=$BACKEND_RELEASE"');
  });

  it("never prints raw document output: only strict RT_* lines reach the log and the ledger", () => {
    const ssm = String(stepNamed("Run the SSM gates", live.steps).run);
    expect(ssm).toContain("RESULT_RE='^RT_(GATE|FAIL|PRIOR|TARGET|BACKUP|REVERT|DONE)( [A-Za-z0-9=:._/-]+)*$'");
    expect(ssm).toMatch(/--query StandardOutputContent --output text 2>\/dev\/null \\\n\s+\| grep -E "\$RESULT_RE" > "\$LIVE\/\$label\.lines"/);
    expect(ssm).not.toContain("StandardErrorContent");
    // a bounded poll, not the ~100 s aws ssm wait
    expect(ssm).not.toContain("aws ssm wait");
    expect(ssm).toContain("deadline=$(( $(date +%s) + limit ))");
  });

  it("lets no operator set RollbackAllowed or the backup reference: they come from this run's verifier and lab-02 output", () => {
    const inputs = Object.keys(workflow.on.workflow_dispatch?.inputs ?? {});
    expect(inputs.sort()).toEqual(["backend_release", "current_release", "dry_run", "jira_key", "target"]);
    expect(inputs.some((i) => /rollback|backup/i.test(i))).toBe(false);
    // RollbackAllowed: verifier ledger -> preflight step output -> job output -> live env, never an input
    expect(preflight.outputs?.rollback_allowed).toBe("${{ steps.plan.outputs.rollback_allowed }}");
    for (const step of live.steps.filter((s) => s.env?.ROLLBACK_ALLOWED !== undefined)) {
      expect(step.env?.ROLLBACK_ALLOWED).toBe("${{ needs.preflight.outputs.rollback_allowed }}");
    }
    // undecidable (no verified current release, or any rollback doubt) is false
    expect(stepNamed("Export the verified plan").run).toContain("(.plan.migrations.added != null and .plan.migrations.rollback.allowed == true) | tostring");
    // BackupName / BackupSha256 exist only as shell variables parsed from the backup command's RT_BACKUP line
    expect(workflowText).not.toMatch(/inputs\.\w*backup|BACKUP_NAME: \$\{\{|BACKUP_SHA256: \$\{\{/i);
    const ssm = String(stepNamed("Run the SSM gates", live.steps).run);
    expect(ssm.indexOf('run_document backup "$LAB02"')).toBeLessThan(ssm.indexOf('BACKUP_LINE="$(grep -E'));
    expect(ssm).toContain("^RT_BACKUP name=rtlab-[0-9a-f]{12}-to-[0-9a-f]{12}-[0-9]{8}T[0-9]{6}Z\\.dump sha256=[0-9a-f]{64}$");
  });

  it("passes the documents exactly their parameters", () => {
    const ssm = String(stepNamed("Run the SSM gates", live.steps).run);
    const keys = (label: string): string[] => {
      const m = new RegExp(String.raw`'\{(ReleaseTag[^}]*)\}' > "\$LIVE/${label}-params\.json"`).exec(ssm);
      if (!m) throw new Error(`no ${label} parameters`);
      return [...(m[1] ?? "").matchAll(/(\w+): \[/g)].map((k) => k[1] ?? "").sort();
    };
    const docParams = (file: string): string[] =>
      Object.keys((yaml.load(read(`deploy/lab/ssm/${file}`)) as { parameters: Record<string, unknown> }).parameters).sort();
    expect(keys("backup")).toEqual(docParams("RT-BackendLabBackup.yaml"));
    expect(keys("deploy")).toEqual(docParams("RT-BackendLabDeploy.yaml"));
  });

  it("always writes and uploads a live ledger with digests, backup, gates and the failure boundary", () => {
    const ledger = stepNamed("Write the live ledger", live.steps);
    expect(ledger.if).toBe("always()");
    for (const field of ["prior:", "targetDigests:", "backup:", "gates:", "failureBoundary:", "rollbackAllowed:"]) expect(ledger.run).toContain(field);
    // the current release is "host-verified" only when the document reported G-Host passing
    expect(ledger.run).toContain('source: (if ($all | any(. == "RT_GATE G-Host pass"))');
    expect(ledger.run).toContain('else "not host-verified: G-Host did not pass" end)');
    expect(stepNamed("Upload the live ledger", live.steps)).toMatchObject({ if: "always()", with: { path: "${{ runner.temp }}/live-ledger/" } });
  });
});
