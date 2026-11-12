import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assessRuntimeConfig,
  getBakedLaneConfig,
  initBakedLaneConfig,
  loadLaneConfig,
  parseLaneConfig,
  resolveLaneValue,
  setBakedLaneConfig,
  validateLaneConfig,
} from '../lane-config.js';
import type { LaneConfig } from '../lane-config.js';

/**
 * RT-1346 (RT-1345 D1, D2, D4) — the baked lane configuration: its all-or-nothing
 * validation, the one precedence rule (environment, then the baked file, then nothing)
 * and the "what is missing" assessment behind the Arabic message.
 */

const PROJECT_ID = 'P2abcdefghijklmnopqrstuvwxyz'; // 28 chars: a US project id
const REGIONAL_ID = 'P2abcdefghijklmnopqrstuvwxyz1234'; // 33 chars: regional
const API = 'https://api.pilot.example';

const FULL = {
  lane: 'pilot',
  apiBaseUrl: API,
  descopeProjectId: PROJECT_ID,
  updateOrigin: 'https://updates.example/pilot',
  updateChannel: 'canary',
};

const BAKED: LaneConfig = { lane: 'pilot', apiBaseUrl: API, descopeProjectId: PROJECT_ID };

afterEach(() => {
  setBakedLaneConfig(null);
});

describe('validateLaneConfig', () => {
  it('accepts every field', () => {
    expect(validateLaneConfig(FULL)).toEqual({ ok: true, config: FULL });
  });

  it('accepts the lane alone, and each lane', () => {
    for (const lane of ['lab', 'pilot', 'production']) {
      expect(validateLaneConfig({ lane })).toEqual({ ok: true, config: { lane } });
    }
  });

  it('refuses a field that is not in the list, naming the field', () => {
    expect(validateLaneConfig({ ...FULL, sentryDsn: 'https://x.example' })).toEqual({
      ok: false,
      reason: 'unknown_field',
      field: 'sentryDsn',
    });
  });

  it('refuses a missing lane', () => {
    expect(validateLaneConfig({ apiBaseUrl: API })).toEqual({
      ok: false,
      reason: 'missing_lane',
      field: 'lane',
    });
  });

  it.each([null, [], 'text', 7])('refuses %j as not an object', (raw) => {
    expect(validateLaneConfig(raw)).toEqual({ ok: false, reason: 'not_an_object' });
  });

  it.each([
    ['lane', 'staging'],
    ['lane', 'Pilot'],
    ['apiBaseUrl', 'http://api.pilot.example'],
    ['apiBaseUrl', 'api.pilot.example'],
    ['apiBaseUrl', 'https://user:pass@api.pilot.example'],
    ['apiBaseUrl', 'https://api.pilot.example/?k=v'],
    ['apiBaseUrl', 'https://api.pilot.example/#frag'],
    ['apiBaseUrl', ' https://api.pilot.example'],
    ['apiBaseUrl', ''],
    ['descopeProjectId', 'not-an-id'],
    ['descopeProjectId', REGIONAL_ID],
    ['descopeProjectId', ''],
    ['updateOrigin', 'http://updates.example'],
    ['updateChannel', 'beta'],
    ['updateChannel', 'LAB'],
    ['apiBaseUrl', 42],
    ['descopeProjectId', null],
  ])('refuses %s = %j (wrong shape)', (field, value) => {
    expect(validateLaneConfig({ ...FULL, [field]: value })).toEqual({
      ok: false,
      reason: 'invalid_value',
      field,
    });
  });

  it.each([
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signaturepart',
    '-----BEGIN PRIVATE KEY-----',
    'Bearer abcdef',
    'sk_live_abcdef123456',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'xoxb-1234-abcd',
  ])('refuses a value that looks like a secret (%s)', (value) => {
    expect(validateLaneConfig({ ...FULL, apiBaseUrl: value })).toEqual({
      ok: false,
      reason: 'looks_like_secret',
      field: 'apiBaseUrl',
    });
  });

  it('never echoes a rejected value in the verdict', () => {
    const verdict = validateLaneConfig({ lane: 'pilot', apiBaseUrl: 'http://leaky.example' });
    expect(JSON.stringify(verdict)).not.toContain('leaky');
  });

  it('is all or nothing: one bad field refuses the others too', () => {
    const verdict = validateLaneConfig({ ...FULL, updateChannel: 'beta' });
    expect(verdict.ok).toBe(false);
  });
});

describe('parseLaneConfig', () => {
  it('parses a valid file', () => {
    expect(parseLaneConfig(`${JSON.stringify(FULL)}\n`)).toEqual({ ok: true, config: FULL });
  });

  it('refuses text that is not JSON', () => {
    expect(parseLaneConfig('{ nope')).toEqual({ ok: false, reason: 'not_json' });
    expect(parseLaneConfig('')).toEqual({ ok: false, reason: 'not_json' });
  });

  it('refuses a JSON value that is not an object', () => {
    expect(parseLaneConfig('[]')).toEqual({ ok: false, reason: 'not_an_object' });
  });
});

describe('loadLaneConfig', () => {
  function logger() {
    return { info: vi.fn(), warn: vi.fn() };
  }

  it('returns the configuration of a valid file', () => {
    const log = logger();
    expect(loadLaneConfig('f', log, () => JSON.stringify(FULL))).toEqual(FULL);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('treats an absent file as no configuration: today, with one info line and no warning', () => {
    const log = logger();
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
    expect(
      loadLaneConfig('f', log, () => {
        throw missing;
      }),
    ).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ event: 'lane_config.absent' }, expect.any(String));
  });

  it('refuses a file it cannot read, with one warning', () => {
    const log = logger();
    expect(
      loadLaneConfig('f', log, () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
    ).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      { event: 'lane_config.refused', reason: 'unreadable' },
      expect.any(String),
    );
  });

  it('refuses a malformed file entirely: null, one warning with the reason and no value', () => {
    const log = logger();
    expect(loadLaneConfig('f', log, () => '{ "lane": "pilot", ')).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { event: 'lane_config.refused', reason: 'not_json', field: undefined },
      expect.any(String),
    );
  });

  it('refuses a file with an unknown field entirely, never partly applied', () => {
    const log = logger();
    const text = JSON.stringify({ ...FULL, extra: 'x' });
    expect(loadLaneConfig('f', log, () => text)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      { event: 'lane_config.refused', reason: 'unknown_field', field: 'extra' },
      expect.any(String),
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(PROJECT_ID);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(API);
  });
});

describe('resolveLaneValue — the one precedence rule', () => {
  it('the environment wins over the baked value', () => {
    expect(resolveLaneValue('https://env.example', API)).toEqual({
      value: 'https://env.example',
      source: 'env',
    });
  });

  it('with no environment value the baked value is used', () => {
    expect(resolveLaneValue(undefined, API)).toEqual({ value: API, source: 'baked' });
  });

  it.each(['', '   '])('a blank environment value (%j) counts as unset', (blank) => {
    expect(resolveLaneValue(blank, API)).toEqual({ value: API, source: 'baked' });
  });

  it('with neither there is nothing, so the caller refuses', () => {
    expect(resolveLaneValue(undefined, undefined)).toEqual({ value: undefined, source: 'none' });
    expect(resolveLaneValue('  ', undefined)).toEqual({ value: undefined, source: 'none' });
  });

  it('an environment value is authoritative even when it is invalid: it is not replaced by the baked one', () => {
    expect(resolveLaneValue('garbage', API).value).toBe('garbage');
  });
});

describe('initBakedLaneConfig and the holder', () => {
  it('starts empty, which is today', () => {
    expect(getBakedLaneConfig()).toBeNull();
  });

  it('an absent dist/lane-config.json leaves the holder empty, which is today', () => {
    const info = vi.fn();
    initBakedLaneConfig({
      appPath: path.join(tmpdir(), 'rt1346-no-such-app'),
      logger: { info, warn: vi.fn() },
      env: {},
    });
    expect(getBakedLaneConfig()).toBeNull();
    expect(info).toHaveBeenCalledWith({ event: 'lane_config.absent' }, expect.any(String));
  });

  it('loads dist/lane-config.json under the app path and logs each source, never a value', () => {
    const app = mkdtempSync(path.join(tmpdir(), 'rt1346-app-'));
    try {
      mkdirSync(path.join(app, 'dist'));
      writeFileSync(path.join(app, 'dist', 'lane-config.json'), JSON.stringify(FULL));
      const info = vi.fn();
      initBakedLaneConfig({
        appPath: app,
        logger: { info, warn: vi.fn() },
        env: { VITE_API_BASE_URL: 'https://env.example' },
      });
      expect(getBakedLaneConfig()).toEqual(FULL);
      expect(info).toHaveBeenCalledWith(
        {
          event: 'lane_config.loaded',
          lane: 'pilot',
          api_base_url: 'env',
          descope_project_id: 'baked',
        },
        expect.any(String),
      );
      expect(JSON.stringify(info.mock.calls)).not.toContain(PROJECT_ID);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('a malformed dist/lane-config.json leaves the holder empty: refused entirely', () => {
    const app = mkdtempSync(path.join(tmpdir(), 'rt1346-app-'));
    try {
      mkdirSync(path.join(app, 'dist'));
      writeFileSync(
        path.join(app, 'dist', 'lane-config.json'),
        JSON.stringify({ ...FULL, extra: 'x' }),
      );
      const warn = vi.fn();
      initBakedLaneConfig({ appPath: app, logger: { info: vi.fn(), warn }, env: {} });
      expect(getBakedLaneConfig()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('survives an app path that is not a string (a mocked electron app)', () => {
    expect(() => {
      initBakedLaneConfig({
        appPath: undefined as unknown as string,
        logger: { info: vi.fn(), warn: vi.fn() },
        env: {},
      });
    }).not.toThrow();
    expect(getBakedLaneConfig()).toBeNull();
  });
});

describe('assessRuntimeConfig — what is missing after resolution', () => {
  const ENV_OK = { VITE_API_BASE_URL: 'https://env.example', DESCOPE_PROJECT_ID: PROJECT_ID };

  it('is complete when the environment supplies both', () => {
    expect(assessRuntimeConfig(ENV_OK, null)).toBeNull();
  });

  it('is complete when only the baked file supplies both (no environment variables)', () => {
    expect(assessRuntimeConfig({}, BAKED)).toBeNull();
  });

  it('mixes sources: address from the environment, project id baked', () => {
    expect(assessRuntimeConfig({ VITE_API_BASE_URL: 'https://env.example' }, BAKED)).toBeNull();
  });

  it('names the server address when neither source has one', () => {
    expect(assessRuntimeConfig({ DESCOPE_PROJECT_ID: PROJECT_ID }, null)).toBe('server_address');
    expect(assessRuntimeConfig({}, { lane: 'pilot', descopeProjectId: PROJECT_ID })).toBe(
      'server_address',
    );
  });

  it('names the server address when the value is not a URL', () => {
    expect(assessRuntimeConfig({ ...ENV_OK, VITE_API_BASE_URL: 'not a url' }, BAKED)).toBe(
      'server_address',
    );
  });

  it('names the sign-in identity when neither source has a project id', () => {
    expect(assessRuntimeConfig({ VITE_API_BASE_URL: 'https://env.example' }, null)).toBe(
      'identity_provider',
    );
  });

  it.each(['nope', REGIONAL_ID])('names the sign-in identity for a bad project id %j', (id) => {
    expect(assessRuntimeConfig({ ...ENV_OK, DESCOPE_PROJECT_ID: id }, BAKED)).toBe(
      'identity_provider',
    );
  });

  it('reports the server address first when both are missing', () => {
    expect(assessRuntimeConfig({}, null)).toBe('server_address');
  });

  it('does not call another provider a missing setting', () => {
    expect(
      assessRuntimeConfig({ ...ENV_OK, OPERATOR_IDENTITY_PROVIDER: 'other' }, null),
    ).toBeNull();
  });

  it('defaults to the holder', () => {
    setBakedLaneConfig(BAKED);
    expect(assessRuntimeConfig({})).toBeNull();
    setBakedLaneConfig(null);
    expect(assessRuntimeConfig({})).toBe('server_address');
  });
});
