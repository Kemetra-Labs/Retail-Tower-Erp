import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../feed/channel-promotion-plan-cli';
import {
  compareVersions,
  planPromotion,
  type PlanResult,
  type PromotionRequest,
  type ReleaseFacts,
} from '../feed/channel-promotion-plan';
import {
  EVIDENCE,
  LAB_PIN,
  PROD_PIN,
  channelYml,
  laneState,
  pinFor,
  release,
} from './fixtures/feed/release-facts';

/**
 * RT-1393 — the offline promotion plan verifier (RT-1390 decision record, sections 4 and 5).
 * Every case below is a fail-closed rule from the RT-1393 acceptance criteria; each refusal has
 * its own stable reason code.
 */

const promote = (
  lane: string,
  stage: string,
  extra: Partial<Extract<PromotionRequest, { mode: 'promote' }>> = {},
): PromotionRequest => ({
  mode: 'promote',
  lane,
  stage,
  pin: lane === 'lab' ? LAB_PIN : pinFor(lane as 'pilot' | 'production'),
  evidenceRef: EVIDENCE,
  ...extra,
});

function refusal(result: PlanResult): string {
  if (result.ok) throw new Error(`expected a refusal, got a plan: ${JSON.stringify(result.plan)}`);
  return result.reason;
}

function plan(result: PlanResult) {
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}: ${result.detail}`);
  return result.plan;
}

function withManifest(
  facts: ReleaseFacts,
  edit: (m: Record<string, unknown>) => void,
): ReleaseFacts {
  const manifest = structuredClone(facts.manifest) as Record<string, unknown>;
  edit(manifest);
  return { ...facts, manifest };
}

describe('planPromotion — valid plans', () => {
  it('writes a missing installer and blockmap before any channel file', () => {
    const facts = release('production', '1.1.0');
    const state = laneState('production', { lab: '1.1.0', canary: '1.0.0', stable: '1.0.0' });
    const result = plan(planPromotion(promote('production', 'canary'), facts, state));
    expect(result.writes.map((w) => w.file)).toEqual(['canary.yml']);

    const fresh = release('production', '1.3.0');
    const lab = plan(planPromotion(promote('production', 'lab'), fresh, state));
    expect(lab.writes.map((w) => w.file)).toEqual([
      'POS-Pulse-Setup-1.3.0.exe',
      'POS-Pulse-Setup-1.3.0.exe.blockmap',
      'lab.yml',
    ]);
    const last = lab.writes.at(-1);
    expect(last?.kind).toBe('channel');
    if (last?.kind === 'channel') {
      const yml = load(last.content) as Record<string, unknown>;
      expect(yml['version']).toBe('1.3.0');
      expect(yml['path']).toBe('POS-Pulse-Setup-1.3.0.exe');
      expect(yml).not.toHaveProperty('stagingPercentage');
    }
  });

  it('fans a stable release out to every earlier channel that is lower, never across lanes', () => {
    const facts = release('production', '2.0.0');
    const state = laneState('production', { lab: '2.0.0', canary: '2.0.0', stable: '1.0.0' });
    const lower = laneState('production', { lab: '1.9.0' });
    const result = plan(
      planPromotion(promote('production', 'stable', { stagingPercentage: 25 }), facts, {
        channels: { ...state.channels, ...lower.channels },
        files: { ...state.files, ...lower.files },
      }),
    );
    const channels = result.writes.filter((w) => w.kind === 'channel');
    expect(channels.map((w) => w.file)).toEqual(['lab.yml', 'stable.yml']);
    const stable = channels.at(-1);
    if (stable?.kind === 'channel') {
      expect((load(stable.content) as Record<string, unknown>)['stagingPercentage']).toBe(25);
    }
    expect(result.lane).toBe('production');
  });

  it('raises the stable staging percentage of the same version', () => {
    const facts = release('production', '1.0.0');
    const state = laneState(
      'production',
      { lab: '1.0.0', canary: '1.0.0', stable: '1.0.0' },
      { stable: 10 },
    );
    const result = plan(
      planPromotion(promote('production', 'stable', { stagingPercentage: 100 }), facts, state),
    );
    expect(result.writes.map((w) => w.file)).toEqual(['stable.yml']);
  });

  it('promotes a lab-signed release inside the lab lane only', () => {
    const facts = release('lab', '0.1.2');
    const result = plan(
      planPromotion(promote('lab', 'lab'), facts, laneState('lab', { lab: '0.1.1' })),
    );
    expect(result.writes.map((w) => w.file)).toEqual([
      'POS-Pulse-LAB-Setup-0.1.2.exe',
      'POS-Pulse-LAB-Setup-0.1.2.exe.blockmap',
      'lab.yml',
    ]);
  });

  it('accepts a pilot-signed release in the pilot lane (data only)', () => {
    const facts = release('pilot', '0.1.5');
    const result = plan(planPromotion(promote('pilot', 'lab'), facts, laneState('pilot', {})));
    expect(result.lane).toBe('pilot');
  });
});

describe('planPromotion — refusals (one reason code each)', () => {
  const prodState = laneState('production', { lab: '1.0.0', canary: '1.0.0', stable: '1.0.0' });

  it('refuses a lab publisher outside the lab lane', () => {
    const facts = { ...release('production', '1.1.0'), publisher: LAB_PIN };
    expect(
      refusal(planPromotion(promote('production', 'lab', { pin: LAB_PIN }), facts, prodState)),
    ).toBe('lab_publisher_outside_lab');
  });

  it('refuses a signing class that does not match the lane', () => {
    const labIntoProd = { ...release('lab', '1.1.0'), publisher: PROD_PIN };
    expect(refusal(planPromotion(promote('production', 'lab'), labIntoProd, prodState))).toBe(
      'signing_mismatch',
    );
    const pilotIntoProd = { ...release('pilot', '1.1.0'), publisher: PROD_PIN };
    expect(refusal(planPromotion(promote('production', 'lab'), pilotIntoProd, prodState))).toBe(
      'signing_mismatch',
    );
    const missing = withManifest(release('production', '1.1.0'), (m) => delete m['signing']);
    expect(refusal(planPromotion(promote('production', 'lab'), missing, prodState))).toBe(
      'signing_mismatch',
    );
    const signedLab = withManifest(release('lab', '0.1.2'), (m) => (m['signing'] = 'lab'));
    expect(refusal(planPromotion(promote('lab', 'lab'), signedLab, laneState('lab', {})))).toBe(
      'signing_mismatch',
    );
  });

  it('refuses a publisher that is not the lane pin', () => {
    const facts = { ...release('production', '1.1.0'), publisher: 'Someone Else' };
    expect(refusal(planPromotion(promote('production', 'lab'), facts, prodState))).toBe(
      'publisher_mismatch',
    );
  });

  it('refuses a manifest that does not name this release', () => {
    const wrongTag = withManifest(
      release('production', '1.1.0'),
      (m) => (m['tag'] = 'pos-pilot/v1.1.0'),
    );
    expect(refusal(planPromotion(promote('production', 'lab'), wrongTag, prodState))).toBe(
      'manifest_mismatch',
    );
    const wrongDigest = withManifest(release('production', '1.1.0'), (m) => {
      const artifacts = m['artifacts'] as Record<string, unknown>[];
      const installer = artifacts.find((a) => a['name'] === 'pos-installer');
      if (installer) installer['digest'] = `sha256:${'0'.repeat(64)}`;
    });
    expect(refusal(planPromotion(promote('production', 'lab'), wrongDigest, prodState))).toBe(
      'manifest_mismatch',
    );
    const noBlockmap = { ...release('production', '1.1.0'), blockmap: undefined };
    expect(refusal(planPromotion(promote('production', 'lab'), noBlockmap, prodState))).toBe(
      'manifest_mismatch',
    );
  });

  it.each([
    ['version', { version: '1.1.1' }],
    ['path', { path: 'POS-Pulse-Setup-other.exe' }],
    ['sha512', { sha512: 'AAAA' }],
  ])('refuses a channel file whose %s does not match the installer', (_field, override) => {
    const base = release('production', '1.1.0');
    const text = channelYml(base.installer.name, base.installer.sha512, base.installer.size, {
      version: '1.1.0',
      ...override,
    });
    const facts = withManifest({ ...base, channelFileText: text }, (m) => {
      const channel = (m['artifacts'] as Record<string, unknown>[]).find(
        (a) => a['name'] === 'pos-channel',
      );
      if (channel) channel['digest'] = sha256Text(text);
    });
    expect(refusal(planPromotion(promote('production', 'lab'), facts, prodState))).toBe(
      'channel_file_mismatch',
    );
  });

  it('refuses a channel file whose size does not match the installer', () => {
    const base = release('production', '1.1.0');
    const facts = { ...base, installer: { ...base.installer, size: base.installer.size + 1 } };
    expect(refusal(planPromotion(promote('production', 'lab'), facts, prodState))).toBe(
      'channel_file_mismatch',
    );
  });

  it('refuses a version that is not higher than the target channel', () => {
    const facts = release('production', '1.0.0');
    expect(refusal(planPromotion(promote('production', 'lab'), facts, prodState))).toBe(
      'version_not_higher',
    );
    const older = release('production', '0.9.0');
    expect(refusal(planPromotion(promote('production', 'lab'), older, prodState))).toBe(
      'version_not_higher',
    );
  });

  it('refuses an installer name already on the feed with different bytes', () => {
    const facts = release('production', '1.1.0');
    const state = {
      ...prodState,
      files: { ...prodState.files, [facts.installer.name]: `sha256:${'1'.repeat(64)}` },
    };
    expect(refusal(planPromotion(promote('production', 'lab'), facts, state))).toBe(
      'artifact_name_reused',
    );
  });

  it.each([
    'https://evil.example/POS-Pulse-Setup-1.1.0.exe',
    '../POS-Pulse-Setup-1.1.0.exe',
    '/pos-feed/production/POS-Pulse-Setup-1.1.0.exe',
    'sub/POS-Pulse-Setup-1.1.0.exe',
  ])('refuses an unsafe reference in the channel file: %s', (url) => {
    const base = release('production', '1.1.0');
    const text = channelYml(url, base.installer.sha512, base.installer.size, { version: '1.1.0' });
    const facts = { ...base, channelFileText: text };
    expect(refusal(planPromotion(promote('production', 'lab'), facts, prodState))).toBe(
      'channel_file_unsafe_reference',
    );
  });

  it('refuses an unknown lane or channel, and a channel the lane does not have', () => {
    const facts = release('production', '1.1.0');
    expect(refusal(planPromotion(promote('beta', 'lab'), facts, prodState))).toBe('unknown_lane');
    expect(refusal(planPromotion(promote('production', 'pilot'), facts, prodState))).toBe(
      'unknown_channel',
    );
    const lab = release('lab', '0.1.2');
    expect(
      refusal(planPromotion(promote('lab', 'canary'), lab, laneState('lab', { lab: '0.1.2' }))),
    ).toBe('unknown_channel');
  });

  it.each([0, 101, 12.5, undefined])('refuses a stable staging percentage of %s', (pct) => {
    const facts = release('production', '1.1.0');
    const state = laneState('production', { lab: '1.1.0', canary: '1.1.0', stable: '1.0.0' });
    const request = promote('production', 'stable');
    const withPct = pct === undefined ? request : { ...request, stagingPercentage: pct };
    expect(refusal(planPromotion(withPct, facts, state))).toBe('invalid_staging_percentage');
  });

  it('refuses a staging percentage on a channel other than stable', () => {
    const facts = release('production', '1.1.0');
    expect(
      refusal(
        planPromotion(promote('production', 'lab', { stagingPercentage: 50 }), facts, prodState),
      ),
    ).toBe('invalid_staging_percentage');
  });

  it('refuses a lower staging percentage for the same version', () => {
    const facts = release('production', '1.0.0');
    const state = laneState(
      'production',
      { lab: '1.0.0', canary: '1.0.0', stable: '1.0.0' },
      { stable: 50 },
    );
    expect(
      refusal(
        planPromotion(promote('production', 'stable', { stagingPercentage: 20 }), facts, state),
      ),
    ).toBe('staging_percentage_lowered');
  });

  it('refuses a promotion without an https evidence reference', () => {
    const facts = release('production', '1.1.0');
    expect(
      refusal(planPromotion(promote('production', 'lab', { evidenceRef: '' }), facts, prodState)),
    ).toBe('missing_evidence');
    expect(
      refusal(
        planPromotion(
          promote('production', 'lab', { evidenceRef: 'http://x.example/1' }),
          facts,
          prodState,
        ),
      ),
    ).toBe('missing_evidence');
  });

  it('refuses to skip a stage', () => {
    const facts = release('production', '1.1.0');
    expect(refusal(planPromotion(promote('production', 'canary'), facts, prodState))).toBe(
      'stage_skipped',
    );
    expect(
      refusal(
        planPromotion(
          promote('production', 'stable', { stagingPercentage: 10 }),
          facts,
          laneState('production', {}),
        ),
      ),
    ).toBe('stage_skipped');
  });

  it('refuses a channel file that is not valid YAML or misses fields', () => {
    const base = release('production', '1.1.0');
    expect(
      refusal(
        planPromotion(
          promote('production', 'lab'),
          { ...base, channelFileText: 'version: [' },
          prodState,
        ),
      ),
    ).toBe('channel_file_invalid');
    expect(
      refusal(
        planPromotion(
          promote('production', 'lab'),
          { ...base, channelFileText: 'version: 1.1.0\n' },
          prodState,
        ),
      ),
    ).toBe('channel_file_invalid');
  });
});

describe('planPromotion — halt', () => {
  const state = laneState('production', { lab: '1.2.0', canary: '1.2.0', stable: '1.2.0' });
  const goodState = {
    ...state,
    files: { ...state.files, ...laneState('production', { lab: '1.1.0' }).files },
  };
  const halt = (channel: string, reason: string): PromotionRequest => ({
    mode: 'halt',
    lane: 'production',
    channel,
    pin: PROD_PIN,
    reason,
  });

  it('writes the known-good file to the channel and every later stage, latest stage first', () => {
    const result = plan(
      planPromotion(
        halt('canary', 'RT-9999 crash class'),
        release('production', '1.1.0'),
        goodState,
      ),
    );
    expect(result.mode).toBe('halt');
    expect(result.writes.map((w) => w.file)).toEqual(['stable.yml', 'canary.yml']);
    for (const w of result.writes) {
      if (w.kind === 'channel')
        expect((load(w.content) as Record<string, unknown>)['version']).toBe('1.1.0');
    }
  });

  it('refuses a halt without a reason', () => {
    expect(
      refusal(planPromotion(halt('canary', '  '), release('production', '1.1.0'), goodState)),
    ).toBe('halt_reason_missing');
  });

  it('refuses a halt that does not lower the channel', () => {
    expect(
      refusal(planPromotion(halt('canary', 'x'), release('production', '1.2.0'), goodState)),
    ).toBe('halt_not_lower');
  });

  it('refuses a halt to a release whose installer is not on the feed', () => {
    expect(refusal(planPromotion(halt('canary', 'x'), release('production', '1.1.0'), state))).toBe(
      'halt_artifact_missing',
    );
  });

  it('still applies the signing and publisher rules to the known-good release', () => {
    const facts = { ...release('production', '1.1.0'), publisher: LAB_PIN };
    expect(refusal(planPromotion(halt('canary', 'x'), facts, goodState))).toBe(
      'lab_publisher_outside_lab',
    );
  });
});

describe('planPromotion — offline by construction', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = (file: string): string =>
    readFileSync(path.join(here, '..', 'feed', file), 'utf8');
  const imports = (text: string): string[] =>
    [...text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');

  it('the plan module imports only node:crypto and js-yaml', () => {
    expect(imports(source('channel-promotion-plan.ts')).sort()).toEqual(['js-yaml', 'node:crypto']);
  });

  it('neither the module nor its CLI can write a file or open a connection', () => {
    for (const file of ['channel-promotion-plan.ts', 'channel-promotion-plan-cli.ts']) {
      const text = source(file);
      expect(text).not.toMatch(
        /write(File|Sync)|appendFile|createWriteStream|mkdir|rm(Sync)?\(|unlink|rename/,
      );
      expect(text).not.toMatch(/\bfetch\(|node:(http|https|net|tls|dgram|child_process)/);
    }
  });
});

describe('compareVersions (semantic-version precedence)', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.10.0', '1.9.0', 1],
    ['2.0.0', '10.0.0', -1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0-beta.11', 1],
    ['1.0.0-rc.1', '1.0.0-rc.1', 0],
  ])('%s vs %s is %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('channel-promotion-plan CLI (read-only)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function releaseDir(version: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'rt1393-'));
    dirs.push(dir);
    const exe = Buffer.from(`exe ${version}`);
    const map = Buffer.from(`map ${version}`);
    const name = `POS-Pulse-Setup-${version}.exe`;
    const yml = channelYml(name, createHash('sha512').update(exe).digest('base64'), exe.length, {
      version,
    });
    writeFileSync(path.join(dir, name), exe);
    writeFileSync(path.join(dir, `${name}.blockmap`), map);
    writeFileSync(path.join(dir, 'lab.yml'), yml);
    const digest = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
    const manifest = {
      product: 'pos',
      tag: `pos/v${version}`,
      signing: 'production',
      artifacts: [
        { name: 'pos-installer', file: name, digest: digest(exe) },
        { name: 'pos-blockmap', file: `${name}.blockmap`, digest: digest(map) },
        { name: 'pos-channel', file: 'lab.yml', digest: digest(yml) },
      ],
    };
    writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(manifest));
    const request = {
      mode: 'promote',
      lane: 'production',
      stage: 'lab',
      pin: PROD_PIN,
      evidenceRef: EVIDENCE,
      publisher: PROD_PIN,
      installer: name,
      blockmap: `${name}.blockmap`,
      channelFile: 'lab.yml',
    };
    writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request));
    return dir;
  }

  it('prints a plan and exits 0 for a valid release into an empty lane', () => {
    const rel = releaseDir('1.0.0');
    const lane = mkdtempSync(path.join(tmpdir(), 'rt1393-lane-'));
    dirs.push(lane);
    const out: string[] = [];
    const code = runCli(
      ['--request', path.join(rel, 'request.json'), '--release-dir', rel, '--lane-dir', lane],
      (line) => out.push(line),
    );
    expect(code).toBe(0);
    const printed = JSON.parse(out.join('\n')) as PlanResult;
    expect(printed.ok && printed.plan.writes.map((w) => w.file)).toEqual([
      'POS-Pulse-Setup-1.0.0.exe',
      'POS-Pulse-Setup-1.0.0.exe.blockmap',
      'lab.yml',
    ]);
  });

  it('exits 1 on a refusal read from the lane directory, and 2 on bad usage', () => {
    const rel = releaseDir('1.0.0');
    const lane = mkdtempSync(path.join(tmpdir(), 'rt1393-lane-'));
    dirs.push(lane);
    writeFileSync(path.join(lane, 'POS-Pulse-Setup-1.0.0.exe'), 'other bytes');
    const out: string[] = [];
    const args = [
      '--request',
      path.join(rel, 'request.json'),
      '--release-dir',
      rel,
      '--lane-dir',
      lane,
    ];
    expect(runCli(args, (line) => out.push(line))).toBe(1);
    expect((JSON.parse(out.join('\n')) as { reason: string }).reason).toBe('artifact_name_reused');
    expect(runCli(['--request'], () => undefined)).toBe(2);
  });
});

function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
