import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseLaneConfig } from '../../src/main/config/lane-config.js';
import { laneConfigStamp, stampLaneConfig, writeLaneConfigStamp } from '../stamp-lane-config.js';

/**
 * RT-1346 (RT-1345 D1) — the build-time step that writes `dist/lane-config.json`.
 * No input means no file (today's build); any input is validated by the validator the POS
 * runs at start-up, and a refused input fails the build with no file and no value printed.
 */

const PROJECT_ID = 'P2abcdefghijklmnopqrstuvwxyz';
const FULL_ENV = {
  POS_LANE_CONFIG_LANE: 'pilot',
  POS_LANE_CONFIG_API_BASE_URL: 'https://api.pilot.example',
  POS_LANE_CONFIG_DESCOPE_PROJECT_ID: PROJECT_ID,
  POS_LANE_CONFIG_UPDATE_ORIGIN: 'https://updates.example/pilot',
  POS_LANE_CONFIG_UPDATE_CHANNEL: 'canary',
};

describe('laneConfigStamp', () => {
  it('stamps every input into the file fields', () => {
    expect(laneConfigStamp(FULL_ENV)).toEqual({
      kind: 'stamp',
      config: {
        lane: 'pilot',
        apiBaseUrl: 'https://api.pilot.example',
        descopeProjectId: PROJECT_ID,
        updateOrigin: 'https://updates.example/pilot',
        updateChannel: 'canary',
      },
    });
  });

  it('stamps only the inputs that are set (a pilot lane has no update origin)', () => {
    expect(
      laneConfigStamp({
        POS_LANE_CONFIG_LANE: 'pilot',
        POS_LANE_CONFIG_API_BASE_URL: 'https://api.pilot.example',
        POS_LANE_CONFIG_UPDATE_ORIGIN: '',
        POS_LANE_CONFIG_UPDATE_CHANNEL: '  ',
      }),
    ).toEqual({
      kind: 'stamp',
      config: { lane: 'pilot', apiBaseUrl: 'https://api.pilot.example' },
    });
  });

  it('without inputs there is no stamp: today', () => {
    expect(laneConfigStamp({})).toEqual({ kind: 'none' });
    expect(
      laneConfigStamp({ POS_LANE_CONFIG_LANE: '', POS_LANE_CONFIG_API_BASE_URL: ' ' }),
    ).toEqual({ kind: 'none' });
  });

  it('never reads the runtime variable names: a machine that has them set bakes nothing', () => {
    expect(
      laneConfigStamp({
        VITE_API_BASE_URL: 'https://api.dev.example',
        DESCOPE_PROJECT_ID: PROJECT_ID,
        ELECTRON_UPDATE_FEED_URL: 'https://updates.dev.example',
        POS_PULSE_UPDATE_CHANNEL: 'lab',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('refuses an unknown POS_LANE_CONFIG_* name, naming it', () => {
    expect(
      laneConfigStamp({ ...FULL_ENV, POS_LANE_CONFIG_SENTRY_DSN: 'https://k@o.example/1' }),
    ).toEqual({
      kind: 'refused',
      reason: 'unknown_field',
      name: 'POS_LANE_CONFIG_SENTRY_DSN',
    });
  });

  it('ignores a blank unknown name (an unset GitHub variable arrives empty)', () => {
    expect(laneConfigStamp({ ...FULL_ENV, POS_LANE_CONFIG_OTHER: '' }).kind).toBe('stamp');
  });

  it('refuses a mis-cased POS_LANE_CONFIG_* name instead of ignoring it (case-sensitive runners)', () => {
    expect(
      laneConfigStamp({ ...FULL_ENV, pos_lane_config_api_base_url: 'https://other.example' }),
    ).toEqual({
      kind: 'refused',
      reason: 'unknown_field',
      name: 'pos_lane_config_api_base_url',
    });
  });

  it('refuses any input without a lane', () => {
    expect(laneConfigStamp({ POS_LANE_CONFIG_API_BASE_URL: 'https://api.pilot.example' })).toEqual({
      kind: 'refused',
      reason: 'missing_lane',
      name: 'POS_LANE_CONFIG_LANE',
    });
  });

  it.each([
    ['POS_LANE_CONFIG_API_BASE_URL', 'http://api.pilot.example', 'invalid_value'],
    ['POS_LANE_CONFIG_API_BASE_URL', 'https://u:p@api.pilot.example', 'invalid_value'],
    ['POS_LANE_CONFIG_DESCOPE_PROJECT_ID', 'nope', 'invalid_value'],
    ['POS_LANE_CONFIG_UPDATE_CHANNEL', 'beta', 'invalid_value'],
    ['POS_LANE_CONFIG_LANE', 'staging', 'invalid_value'],
    ['POS_LANE_CONFIG_UPDATE_ORIGIN', 'Bearer abcdef', 'looks_like_secret'],
  ])('refuses %s = %j (%s)', (name, value, reason) => {
    expect(laneConfigStamp({ ...FULL_ENV, [name]: value })).toEqual({
      kind: 'refused',
      reason,
      name,
    });
  });
});

describe('stampLaneConfig (the file and the exit code)', () => {
  let dir: string;
  let file: string;
  let lines: string[];
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'rt1346-stamp-'));
    file = path.join(dir, 'dist', 'lane-config.json');
    lines = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const log = (line: string): void => {
    lines.push(line);
  };

  it('writes a file the POS loader accepts, with exit 0', () => {
    expect(stampLaneConfig(file, FULL_ENV, log)).toBe(0);
    const verdict = parseLaneConfig(readFileSync(file, 'utf8'));
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.config.lane).toBe('pilot');
  });

  it('a build with no inputs produces no file', () => {
    expect(stampLaneConfig(file, {}, log)).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('a build with no inputs removes a stale file from an earlier build', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"lane":"pilot"}\n');
    expect(stampLaneConfig(file, {}, log)).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('a refused input fails the build (exit 1), writes no file, removes a stale one, prints no value', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"lane":"pilot"}\n');
    const env = { ...FULL_ENV, POS_LANE_CONFIG_API_BASE_URL: 'http://leaky.example' };
    expect(stampLaneConfig(file, env, log)).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(lines.join('\n')).toContain('POS_LANE_CONFIG_API_BASE_URL');
    expect(lines.join('\n')).not.toContain('leaky');
    expect(lines.join('\n')).not.toContain(PROJECT_ID);
  });

  it('writeLaneConfigStamp creates dist/ and ends the file with a newline', () => {
    writeLaneConfigStamp(file, { lane: 'lab' });
    expect(readFileSync(file, 'utf8')).toBe('{"lane":"lab"}\n');
  });
});
