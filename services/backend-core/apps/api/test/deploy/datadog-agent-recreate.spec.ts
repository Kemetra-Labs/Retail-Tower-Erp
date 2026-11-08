/**
 * RT-1282 — a Backend-Core lab deploy recreates the Datadog agent when the
 * release's compose files change.
 *
 * The agent is the opt-in compose profile `datadog`, and its OpenMetrics check
 * is inline in docker-compose.prod.yml. RT-BackendLabDeploy starts the release
 * with a plain `up -d`, which never touches a profile service, and compose never
 * recreates a container for a config-only change. On 2026-11-08 the v0.7.0 deploy
 * left the agent without the RT-1281 worker scrape until the owner recreated it.
 *
 * The step runs after the auto-revert is cancelled, so telemetry never blocks or
 * rolls back a healthy deploy. It recreates only an agent that was running, only
 * when a compose file differs from the current release's, never stops the run,
 * and reports through the workflow's existing RT_GATE prefix.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';

const serviceRoot = resolve(__dirname, '..', '..', '..', '..');
const repoRoot = resolve(serviceRoot, '..', '..');
const text = readFileSync(
  resolve(serviceRoot, 'deploy/lab/ssm/RT-BackendLabDeploy.yaml'),
  'utf8',
).replace(/\r\n/g, '\n');
const doc = yaml.load(text) as { mainSteps: { inputs: { runCommand: string[] } }[] };
const command = doc.mainSteps.map((s) => s.inputs.runCommand.join('\n')).join('\n');
const body = /<<'RT_DEPLOY_SCRIPT'\n([\s\S]*?)\nRT_DEPLOY_SCRIPT\n/.exec(command)?.[1] ?? '';
const step = /^datadog_agent_step\(\) \{\n[\s\S]*?\n\}$/m.exec(body)?.[0] ?? '';

function bashWorks(): boolean {
  const probe = spawnSync('bash', ['-c', 'printf ok'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout === 'ok';
}
const haveBash = bashWorks();
if (!haveBash && process.env['CI'])
  throw new Error('bash is required in CI for the agent step checks');
const itBash = haveBash ? it : it.skip;

type Case = {
  running: boolean;
  changed: 'none' | 'prod' | 'release' | 'missing';
  upFails?: boolean;
  exitsAfterUp?: boolean;
};

/** Runs the real step from the document with a stub wrapper and a stub service_container. */
function runStep(c: Case): {
  status: number | null;
  result: string;
  calls: string;
  stderr: string;
} {
  const script = [
    'set -euo pipefail',
    'W="$(mktemp -d)"; trap \'rm -rf "$W"\' EXIT',
    'CUR_DIR="$W/release-cur"; TGT_DIR="$W/release-tgt"; DC="$W/dc"; mkdir "$CUR_DIR" "$TGT_DIR"',
    'for f in docker-compose.prod.yml docker-compose.release.yml; do printf \'same\\n\' > "$CUR_DIR/$f"; printf \'same\\n\' > "$TGT_DIR/$f"; done',
    c.changed === 'prod' ? 'printf \'worker scrape\\n\' >> "$TGT_DIR/docker-compose.prod.yml"' : '',
    c.changed === 'release' ? 'printf \'x\\n\' >> "$TGT_DIR/docker-compose.release.yml"' : '',
    c.changed === 'missing' ? 'rm "$CUR_DIR/docker-compose.release.yml"' : '',
    c.running ? 'touch "$W/running"' : '',
    // The stub wrapper records its arguments; it fails, or leaves no running agent, on request.
    `printf '%s\\n' '#!/bin/bash' 'printf "%s\\n" "$*" >> "${'$'}{0%/*}/calls"' ${c.upFails ? "'exit 1'" : ''} ${c.exitsAfterUp ? '\'rm -f "${0%/*}/running"\'' : ''} > "$DC"`,
    'chmod +x "$DC"',
    'service_container() { [ -e "$W/running" ] && printf "cid-%s\\n" "$1"; }',
    'stop() { echo "STOP:$*"; exit 3; }',
    step,
    'datadog_agent_step >/dev/null',
    'printf "result=%s\\n" "$AGENT_RESULT"',
    'printf "calls=%s\\n" "$(cat "$W/calls" 2>/dev/null || true)"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const line = (k: string): string => new RegExp(`^${k}=(.*)$`, 'm').exec(r.stdout)?.[1] ?? '';
  return { status: r.status, result: line('result'), calls: line('calls'), stderr: r.stderr };
}

const RECREATE = '--profile datadog up -d --no-deps --force-recreate datadog-agent';

describe('RT-BackendLabDeploy Datadog agent step (RT-1282)', () => {
  it('is defined once, as a function the spec runs as written', () => {
    expect(step).not.toBe('');
    expect(body.split('datadog_agent_step() {').length).toBe(2);
  });

  it("runs after the auto-revert is cancelled and before RT_DONE, outside the app's gates", () => {
    const at = (needle: string): number => {
      const i = body.indexOf(needle);
      expect({ needle, found: i > -1 }).toEqual({ needle, found: true });
      return i;
    };
    const order = [
      at('pass cancel-revert'),
      at('GATE=datadog-agent'),
      at('datadog_agent_step() {'),
      at('\ndatadog_agent_step\n'),
      at('say "RT_GATE datadog-agent $AGENT_RESULT"'),
      at('say "RT_DONE release=$RELEASE_TAG"'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // never in the revert window: the app's start and the revert script stay unchanged
    expect(body.slice(0, body.indexOf('pass cancel-revert'))).not.toContain('datadog');
  });

  it('never stops or exits: telemetry never blocks or rolls back a deploy', () => {
    expect(step).not.toMatch(/\bstop\b|\bexit\b/);
    expect(step).not.toContain('set +e');
  });

  it('recreates with the profile, no deps and stdin closed, and never pulls the image or renders config', () => {
    expect(step).toContain(`"$DC" ${RECREATE} </dev/null || return 0`);
    expect(step).not.toMatch(/\bpull\b|\bconfig\b|docker inspect/);
  });

  it("reports through the workflow's existing RT_GATE prefix with a result its strict pattern keeps", () => {
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-lab.yml'), 'utf8');
    const re = /RESULT_RE='([^']+)'/.exec(workflow)?.[1];
    expect(re).toBeDefined();
    for (const result of ['pass', 'skip', 'fail'])
      expect(`RT_GATE datadog-agent ${result}`).toMatch(new RegExp(re!));
  });

  itBash('is valid bash', () => {
    const r = spawnSync('bash', ['-n'], { input: step, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  itBash('compose files unchanged (same-release redeploy too): skip, no wrapper call', () => {
    const r = runStep({ running: true, changed: 'none' });
    expect(r).toEqual({ status: 0, result: 'skip', calls: '', stderr: '' });
  });

  itBash(
    'agent not running: skip, even when compose changed (the opt-in profile stays off)',
    () => {
      expect(runStep({ running: false, changed: 'prod' })).toEqual({
        status: 0,
        result: 'skip',
        calls: '',
        stderr: '',
      });
    },
  );

  itBash.each(['prod', 'release', 'missing'] as const)(
    'compose changed (%s) with the agent running: exactly one recreate, pass',
    (changed) => {
      expect(runStep({ running: true, changed })).toEqual({
        status: 0,
        result: 'pass',
        calls: RECREATE,
        stderr: '',
      });
    },
  );

  itBash('recreate fails: fail, and the run carries on to RT_DONE', () => {
    expect(runStep({ running: true, changed: 'prod', upFails: true })).toEqual({
      status: 0,
      result: 'fail',
      calls: RECREATE,
      stderr: '',
    });
  });

  itBash('recreate returns but no agent is running afterwards: fail', () => {
    expect(runStep({ running: true, changed: 'prod', exitsAfterUp: true })).toEqual({
      status: 0,
      result: 'fail',
      calls: RECREATE,
      stderr: '',
    });
  });
});
