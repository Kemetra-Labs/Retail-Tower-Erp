import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkPilotLaneConfig,
  readAsarEntry,
  verifyPackagedPilotLane,
} from '../pilot/verify-pilot-lane-config.js';
import { laneConfigStamp, writeLaneConfigStamp } from '../stamp-lane-config.js';

/**
 * RT-1347 (RT-1345 D1, S2) — the pilot build reads `dist/lane-config.json` back out of the packaged
 * `app.asar` and accepts exactly one shape: lane `pilot`, the API address and the Descope project id,
 * and no update origin or channel. Its digest goes to the release manifest.
 */

const API = 'https://api.pilot.example';
const PROJECT_ID = 'P2abcdefghijklmnopqrstuvwxyz';
const GOOD = { lane: 'pilot', apiBaseUrl: API, descopeProjectId: PROJECT_ID };

const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const text = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);

interface AsarFile {
  readonly bytes: Buffer;
  readonly unpacked?: boolean;
  /** Header integrity hash to record instead of the true one (to simulate a bad archive). */
  readonly integrityHash?: string;
  /** Leave the header integrity entry out, or record another algorithm (to simulate a bad archive). */
  readonly integrity?: 'none' | 'md5';
}

function integrityEntry(file: AsarFile): { integrity?: object } {
  if (file.integrity === 'none') return {};
  const hash = createHash('sha256').update(file.bytes).digest('hex');
  if (file.integrity === 'md5') return { integrity: { algorithm: 'MD5', hash } };
  return { integrity: { algorithm: 'SHA256', hash: file.integrityHash ?? hash } };
}

/** A minimal asar: [4][pickleSize][payloadSize][jsonLength][json, padded to 4][file data]. */
function buildAsar(files: Readonly<Record<string, AsarFile>>): Buffer {
  const tree: { files: Record<string, unknown> } = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [name, file] of Object.entries(files)) {
    const parts = name.split('/');
    const leaf = parts.pop() as string;
    let dir = tree;
    for (const part of parts) {
      dir.files[part] ??= { files: {} };
      dir = dir.files[part] as { files: Record<string, unknown> };
    }
    if (file.unpacked === true) {
      dir.files[leaf] = { size: file.bytes.length, unpacked: true };
      continue;
    }
    dir.files[leaf] = {
      size: file.bytes.length,
      offset: String(offset),
      ...integrityEntry(file),
    };
    chunks.push(file.bytes);
    offset += file.bytes.length;
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Math.ceil(json.length / 4) * 4;
  const payloadSize = 4 + padded;
  const prefix = Buffer.alloc(16 + padded);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(payloadSize + 4, 4);
  prefix.writeUInt32LE(payloadSize, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  return Buffer.concat([prefix, ...chunks]);
}

const withLane = (bytes: Buffer): Record<string, AsarFile> => ({
  'package.json': { bytes: Buffer.from('{"name":"pos"}') },
  'dist/build-identity.json': { bytes: Buffer.from('{"commit":"x"}') },
  'dist/lane-config.json': { bytes },
});

describe('readAsarEntry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'rt1347-asar-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (archive: Buffer): string => {
    const file = path.join(dir, 'app.asar');
    writeFileSync(file, archive);
    return file;
  };

  it('reads one nested entry, not its neighbours', () => {
    const bytes = text(GOOD);
    const file = write(buildAsar(withLane(bytes)));
    expect(readAsarEntry(file, ['dist', 'lane-config.json']).equals(bytes)).toBe(true);
    expect(readAsarEntry(file, ['package.json']).toString()).toBe('{"name":"pos"}');
  });

  it('refuses a missing entry, a directory, an unpacked entry and an entry above the size cap', () => {
    const file = write(
      buildAsar({
        ...withLane(text(GOOD)),
        'dist/unpacked.json': { bytes: Buffer.from('{}'), unpacked: true },
        'dist/big.json': { bytes: Buffer.alloc(70_000, 0x20) },
      }),
    );
    expect(() => readAsarEntry(file, ['dist', 'nope.json'])).toThrow(/not in the archive/);
    expect(() => readAsarEntry(file, ['dist'])).toThrow(/not a packed file/);
    expect(() => readAsarEntry(file, ['dist', 'unpacked.json'])).toThrow(/not a packed file/);
    expect(() => readAsarEntry(file, ['dist', 'big.json'])).toThrow(/larger than/);
  });

  it('refuses an entry whose bytes do not match the integrity hash in the header', () => {
    const file = write(
      buildAsar({
        ...withLane(text(GOOD)),
        'dist/lane-config.json': { bytes: text(GOOD), integrityHash: '0'.repeat(64) },
      }),
    );
    expect(() => readAsarEntry(file, ['dist', 'lane-config.json'])).toThrow(/integrity hash/);
  });

  it.each([
    ['no integrity entry', 'none'],
    ['an unknown integrity algorithm', 'md5'],
  ] as const)('refuses an entry with %s (fail closed, never skipped)', (_label, integrity) => {
    const file = write(
      buildAsar({
        ...withLane(text(GOOD)),
        'dist/lane-config.json': { bytes: text(GOOD), integrity },
      }),
    );
    expect(() => readAsarEntry(file, ['dist', 'lane-config.json'])).toThrow(/no SHA256 integrity/);
  });

  it('refuses a file that is not an asar and a truncated archive', () => {
    expect(() => readAsarEntry(write(Buffer.from('MZ not an archive at all')), ['a'])).toThrow(
      /not an asar archive/,
    );
    expect(() => readAsarEntry(write(Buffer.from('tiny')), ['a'])).toThrow(/shorter than/);
    const whole = buildAsar(withLane(text(GOOD)));
    const cut = write(whole.subarray(0, whole.length - 5));
    expect(() => readAsarEntry(cut, ['dist', 'lane-config.json'])).toThrow(/truncated/);
    expect(() => readAsarEntry(path.join(dir, 'absent.asar'), ['a'])).toThrow();
  });
});

describe('checkPilotLaneConfig', () => {
  it('accepts exactly lane pilot with the API address and the Descope project id', () => {
    const bytes = text(GOOD);
    const verdict = checkPilotLaneConfig(bytes);
    expect(verdict).toEqual({ ok: true, digest: sha256(bytes), config: GOOD });
  });

  it('the digest is of the bytes in the package, not of a re-serialisation', () => {
    const spaced = Buffer.from(` ${JSON.stringify(GOOD, null, 2)}\n`);
    const verdict = checkPilotLaneConfig(spaced);
    expect(verdict.ok && verdict.digest).toBe(sha256(spaced));
  });

  it.each([
    ['the lab lane', { ...GOOD, lane: 'lab' }, /lane/],
    ['the production lane', { ...GOOD, lane: 'production' }, /lane/],
    [
      'a lane only (no values)',
      { lane: 'pilot' },
      /apiBaseUrl is missing.*descopeProjectId is missing/,
    ],
    ['no API address', { lane: 'pilot', descopeProjectId: PROJECT_ID }, /apiBaseUrl is missing/],
    ['no Descope project id', { lane: 'pilot', apiBaseUrl: API }, /descopeProjectId is missing/],
    [
      'an update origin',
      { ...GOOD, updateOrigin: 'https://updates.example/pilot' },
      /updateOrigin must be absent/,
    ],
    ['an update channel', { ...GOOD, updateChannel: 'stable' }, /updateChannel must be absent/],
    ['an unknown field', { ...GOOD, token: 'x' }, /unknown_field/],
    [
      'an invalid API address',
      { ...GOOD, apiBaseUrl: 'http://api.pilot.example' },
      /invalid_value/,
    ],
    ['an invalid project id', { ...GOOD, descopeProjectId: 'nope' }, /invalid_value/],
  ])('refuses %s', (_label, value, problem) => {
    const verdict = checkPilotLaneConfig(text(value));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.problems.join(' | ')).toMatch(problem);
  });

  it('refuses text that is not JSON and JSON that is not an object', () => {
    for (const bytes of [
      Buffer.from('not json'),
      Buffer.from('[]'),
      Buffer.from('null'),
      Buffer.alloc(0),
    ]) {
      expect(checkPilotLaneConfig(bytes).ok).toBe(false);
    }
  });

  it('never repeats a configuration value in its problems', () => {
    const verdict = checkPilotLaneConfig(
      text({
        ...GOOD,
        apiBaseUrl: 'http://api.pilot.example',
        updateOrigin: 'https://u.example/x',
      }),
    );
    expect(verdict.ok).toBe(false);
    const said = verdict.ok ? '' : verdict.problems.join(' | ');
    expect(said).not.toContain('api.pilot.example');
    expect(said).not.toContain('u.example');
    expect(said).not.toContain(PROJECT_ID);
  });
});

describe('verifyPackagedPilotLane', () => {
  let dir: string;
  let asar: string;
  let output: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'rt1347-verify-'));
    asar = path.join(dir, 'app.asar');
    output = path.join(dir, 'github-output');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (archive: Buffer | null, env: Readonly<Record<string, string | undefined>> = {}) => {
    if (archive !== null) writeFileSync(asar, archive);
    const logs: string[] = [];
    const errors: string[] = [];
    const code = verifyPackagedPilotLane(
      asar,
      { GITHUB_OUTPUT: output, ...env },
      (line) => logs.push(line),
      (line) => errors.push(line),
    );
    return { code, logs: logs.join('\n'), errors: errors.join('\n') };
  };

  it('passes a good package, prints no value and hands the digest to the step output', () => {
    const bytes = text(GOOD);
    const { code, logs, errors } = run(buildAsar(withLane(bytes)));
    expect(code).toBe(0);
    expect(errors).toBe('');
    expect(logs).toContain(sha256(bytes));
    expect(logs).not.toContain(API);
    expect(logs).not.toContain(PROJECT_ID);
    expect(readFileSync(output, 'utf8')).toBe(`lane_config_digest=${sha256(bytes)}\n`);
  });

  it('passes without GITHUB_OUTPUT (a local run) and writes nothing', () => {
    const { code } = run(buildAsar(withLane(text(GOOD))), { GITHUB_OUTPUT: undefined });
    expect(code).toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it.each([
    ['a lab stamp', text({ ...GOOD, lane: 'lab' })],
    ['a lane-only stamp', text({ lane: 'pilot' })],
    ['an update origin', text({ ...GOOD, updateOrigin: 'https://updates.example/pilot' })],
    ['an update channel', text({ ...GOOD, updateChannel: 'canary' })],
    ['a file that is not JSON', Buffer.from('nope')],
  ])('fails on %s: error annotation, no digest handed on', (_label, bytes) => {
    const { code, errors } = run(buildAsar(withLane(bytes)));
    expect(code).toBe(1);
    expect(errors).toMatch(/::error title=Pilot lane configuration::/);
    expect(existsSync(output)).toBe(false);
  });

  it('fails when the package has no lane-config.json (a build without the stamp)', () => {
    const { code, errors } = run(
      buildAsar({
        'package.json': { bytes: Buffer.from('{}') },
        'dist/build-identity.json': { bytes: Buffer.from('{}') },
      }),
    );
    expect(code).toBe(1);
    expect(errors).toMatch(/lane-config\.json/);
    expect(existsSync(output)).toBe(false);
  });

  it('fails on a missing or unreadable archive', () => {
    const { code, errors } = run(null);
    expect(code).toBe(1);
    expect(errors).toMatch(/::error title=Pilot lane configuration::/);
  });
});

describe('the release workflow inputs, through the real stamp step, into the verifier', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'rt1347-stamp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The environment of the workflow's build step, with the two repository variables substituted. */
  const workflowEnv = (api: string, projectId: string) => ({
    POS_LANE_CONFIG_LANE: 'pilot',
    POS_LANE_CONFIG_API_BASE_URL: api,
    POS_LANE_CONFIG_DESCOPE_PROJECT_ID: projectId,
    POS_LANE_CONFIG_UPDATE_ORIGIN: '',
    POS_LANE_CONFIG_UPDATE_CHANNEL: '',
  });

  const stampToBytes = (env: ReturnType<typeof workflowEnv>): Buffer | null => {
    const stamp = laneConfigStamp(env);
    if (stamp.kind !== 'stamp') return null;
    const file = path.join(dir, 'lane-config.json');
    writeLaneConfigStamp(file, stamp.config);
    return readFileSync(file);
  };

  it('stamps lane pilot with both values and nothing else, and the verifier accepts exactly that', () => {
    const bytes = stampToBytes(workflowEnv(API, PROJECT_ID));
    expect(bytes).not.toBeNull();
    expect(JSON.parse((bytes as Buffer).toString())).toEqual(GOOD);
    expect(checkPilotLaneConfig(bytes as Buffer).ok).toBe(true);
  });

  it('with both variables blank the lane input alone still stamps a lane-only file: the verifier refuses it', () => {
    const bytes = stampToBytes(workflowEnv('', ''));
    expect(bytes).not.toBeNull();
    const verdict = checkPilotLaneConfig(bytes as Buffer);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.problems.join(' | ')).toMatch(
      /apiBaseUrl is missing.*descopeProjectId is missing/,
    );
  });

  it('with one variable blank the stamp writes a partial file, and the verifier refuses it', () => {
    const bytes = stampToBytes(workflowEnv(API, '  '));
    expect(bytes).not.toBeNull();
    const verdict = checkPilotLaneConfig(bytes as Buffer);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.problems.join(' | ')).toMatch(/descopeProjectId is missing/);
  });

  it('an invalid value refuses the stamp itself: the build fails before packaging', () => {
    expect(laneConfigStamp(workflowEnv('http://api.pilot.example', PROJECT_ID)).kind).toBe(
      'refused',
    );
    expect(laneConfigStamp(workflowEnv(API, 'not-a-project-id')).kind).toBe('refused');
  });
});
