/**
 * RT-1282 — a Backend-Core lab deploy recreates the Datadog agent when the release's
 * compose config changes. `RT-BackendLabDeploy` starts the release with `"$DC" up -d`
 * (no `--profile datadog`), so the opt-in agent kept its old inlined check config. The
 * new step sits after cancel-revert: the app deploy is committed and the lock is held.
 * It must never stop, roll back or slow a healthy deploy (telemetry never blocks, RT-617),
 * never pull an image and never render compose config (that would print DD_API_KEY).
 *
 * Static and stubbed: the step runs in bash with a stub compose wrapper, no AWS, no host.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as yaml from "js-yaml";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const text = readFileSync(resolve(repoRoot, "deploy/lab/ssm/RT-BackendLabDeploy.yaml"), "utf8").replace(/\r\n/g, "\n");
const doc = yaml.load(text) as { mainSteps: { inputs: { runCommand: string[] } }[] };
const command = doc.mainSteps.map((s) => s.inputs.runCommand.join("\n")).join("\n");
const body = /<<'RT_\w+_SCRIPT'\n([\s\S]*?)\nRT_\w+_SCRIPT\n/.exec(command)?.[1] ?? "";

const START = "GATE=datadog-agent";
const step = body.slice(body.indexOf(START), body.indexOf('say "RT_DONE'));
// The commands only: the explaining comments name the things the step must not do.
const code = step.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

const haveBash = spawnSync("bash", ["-c", "printf ok"], { encoding: "utf8" }).stdout === "ok";
if (!haveBash && process.env["CI"]) throw new Error("bash is required in CI for the SSM document step checks");
const itBash = haveBash ? it : it.skip;

// A bash path for a temporary directory (Git Bash on Windows reads C:/... but not C:\...).
const tempDir = (): string => mkdtempSync(join(tmpdir(), "rt-dd-agent-")).replace(/\\/g, "/");

type Scenario = {
  agentRunning: boolean;
  /** Compose files of the current release; the target gets `target` (default: the same). */
  current: Record<string, string>;
  target?: Record<string, string>;
  recreateFails?: boolean;
};

function runStep(s: Scenario): { status: number | null; out: string; calls: string[] } {
  const dir = tempDir();
  try {
    const cur = `${dir}/release-cur`;
    const tgt = `${dir}/release-tgt`;
    for (const [d, files] of [[cur, s.current], [tgt, s.target ?? s.current]] as const) {
      mkdirSync(d);
      for (const [name, content] of Object.entries(files)) writeFileSync(`${d}/${name}`, content);
    }
    writeFileSync(`${dir}/dc`, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${dir}/calls"\n[ -z "\${DC_FAILS:-}" ]\n`, { mode: 0o755 });
    const script = [
      "set -euo pipefail",
      'say() { printf "%s\\n" "$*"; }',
      'pass() { say "RT_GATE $1 pass"; }',
      'stop() { say "STOP:$*"; exit 3; }',
      `DC="${dir}/dc"; CUR_DIR="${cur}"; TGT_DIR="${tgt}"`,
      `service_container() { [ "$1" = datadog-agent ] && [ "${s.agentRunning ? "yes" : "no"}" = yes ] && echo abc123; }`,
      step,
      'say "AFTER"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...(s.recreateFails ? { DC_FAILS: "1" } : {}) } });
    const calls = existsSync(`${dir}/calls`) ? readFileSync(`${dir}/calls`, "utf8").split("\n").filter(Boolean) : [];
    return { status: r.status, out: r.stdout, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const compose = { "docker-compose.prod.yml": "services: {}\n", "docker-compose.release.yml": "x: 1\n" };
const RECREATE = "--profile datadog up -d --no-deps --force-recreate --pull never datadog-agent";

describe("RT-BackendLabDeploy: Datadog agent recreate (RT-1282)", () => {
  it("has the step, after cancel-revert and before RT_DONE, and reports through the RT_GATE prefix", () => {
    expect(step.length).toBeGreaterThan(0);
    const at = (needle: string): number => body.indexOf(needle);
    expect(at("pass cancel-revert")).toBeGreaterThan(-1);
    expect(at(START)).toBeGreaterThan(at("pass cancel-revert"));
    expect(at(START)).toBeLessThan(at('say "RT_DONE release=$RELEASE_TAG"'));
    expect(step).toMatch(/say "RT_GATE datadog-agent (\$\w+|pass|skip|fail)"/);
  });

  it("never stops the deploy: no stop call, no revert, no exit in the step", () => {
    expect(code).not.toMatch(/\bstop\b|\bexit\b|systemctl|REVERT|release_claim/);
  });

  it("never pulls an image and never renders compose config (DD_API_KEY would reach the log)", () => {
    expect(code).toContain("--pull never");
    expect(code).not.toMatch(/--pull (always|missing)|docker pull|docker image|\bconfig\b|--build/);
  });

  it("bounds the recreate in time, so a hung daemon cannot hold the run past RT_DONE", () => {
    expect(code).toMatch(/timeout [0-9]+ "\$DC" --profile datadog up /);
    const seconds = Number(/timeout ([0-9]+) "\$DC" --profile datadog/.exec(code)?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(300);
  });

  it("does not name its loop variable COMPOSE_FILE, a Docker Compose environment variable", () => {
    expect(code).not.toMatch(/\bCOMPOSE_FILE\b/);
  });

  it("keeps stdin off the compose call", () => {
    const joined = code.replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n").filter((l) => /"\$DC"/.test(l))) expect(line).toContain("</dev/null");
  });

  itBash("skips when the compose files are unchanged", () => {
    const r = runStep({ agentRunning: true, current: compose });
    expect(r).toEqual({ status: 0, out: "RT_GATE datadog-agent skip\nAFTER\n", calls: [] });
  });

  itBash("recreates the agent when a compose file changed and the agent is running", () => {
    const r = runStep({ agentRunning: true, current: compose, target: { ...compose, "docker-compose.prod.yml": "services: { a: {} }\n" } });
    expect(r).toEqual({ status: 0, out: "RT_GATE datadog-agent pass\nAFTER\n", calls: [RECREATE] });
  });

  itBash("recreates when only the release overlay file changed", () => {
    const r = runStep({ agentRunning: true, current: compose, target: { ...compose, "docker-compose.release.yml": "x: 2\n" } });
    expect(r.calls).toEqual([RECREATE]);
    expect(r.out).toContain("RT_GATE datadog-agent pass");
  });

  itBash("treats a compose file missing from the current release (legacy bundle) as changed", () => {
    const r = runStep({ agentRunning: true, current: { "docker-compose.prod.yml": compose["docker-compose.prod.yml"] }, target: compose });
    expect(r.calls).toEqual([RECREATE]);
  });

  itBash("leaves an agent the owner stopped stopped, even when compose changed", () => {
    const r = runStep({ agentRunning: false, current: compose, target: { ...compose, "docker-compose.prod.yml": "services: { a: {} }\n" } });
    expect(r).toEqual({ status: 0, out: "RT_GATE datadog-agent skip\nAFTER\n", calls: [] });
  });

  itBash("reports fail but lets the deploy continue when the recreate fails", () => {
    const r = runStep({ agentRunning: true, current: compose, target: { ...compose, "docker-compose.prod.yml": "services: { a: {} }\n" }, recreateFails: true });
    expect(r.status).toBe(0);
    // the harness shows stdout, where the real script writes its log line; RT_ lines go to fd 3
    expect(r.out.split("\n").filter((l) => l.startsWith("RT_") || l === "AFTER" || l.startsWith("STOP"))).toEqual(["RT_GATE datadog-agent fail", "AFTER"]);
    expect(r.calls).toEqual([RECREATE]);
  });
});
