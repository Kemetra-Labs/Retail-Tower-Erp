import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadLaneConfig, setBakedLaneConfig } from '../../config/lane-config.js';
import {
  FEATURE_FLAG_ENV,
  assessCashierProfile,
  parseFeatureFlags,
  resolveFeatureFlags,
  type FeatureFlags,
} from '../feature-flags.js';

/**
 * RT-1376 — a pilot-lane build turns the four cashier switches on by default, so a
 * clean install can sell with no Windows environment variable.
 *
 * Precedence: environment, then the lane default, then the switch's existing
 * default. Only the baked lane `pilot` changes anything.
 */

const CASHIER_KEYS = ['cart', 'productSearch', 'payments', 'saleFinalization'] as const;
const TRUTHY_ONLY_KEYS = ['voucherTender', 'cardTender', 'shiftCashup', 'saleVoid'] as const;
const ALL_KEYS = Object.keys(FEATURE_FLAG_ENV) as (keyof FeatureFlags)[];

const UNSET_OR_BLANK: readonly (string | undefined)[] = [undefined, '', '   '];
const TRUTHY = ['1', 'true', 'YES', ' On '];
const FALSY = ['0', 'false', 'No', ' OFF '];
const UNRECOGNISED = ['nonsense', '2', 'enabled'];

describe('parseFeatureFlags with the pilot lane (RT-1376 criterion 1)', () => {
  it('turns the four cashier switches on with no environment value', () => {
    const flags = parseFeatureFlags({}, 'pilot');
    for (const key of CASHIER_KEYS) expect(flags[key], key).toBe(true);
  });

  it.each(UNSET_OR_BLANK)('treats %j as unset: each cashier switch is on', (raw) => {
    for (const key of CASHIER_KEYS) {
      expect(parseFeatureFlags({ [FEATURE_FLAG_ENV[key]]: raw }, 'pilot')[key], key).toBe(true);
    }
  });

  it.each(FALSY)(
    'an explicit falsy value %j turns each cashier switch off (kill switch)',
    (raw) => {
      for (const key of CASHIER_KEYS) {
        expect(parseFeatureFlags({ [FEATURE_FLAG_ENV[key]]: raw }, 'pilot')[key], key).toBe(false);
      }
    },
  );

  it.each(TRUTHY)('a truthy value %j keeps each cashier switch on', (raw) => {
    for (const key of CASHIER_KEYS) {
      expect(parseFeatureFlags({ [FEATURE_FLAG_ENV[key]]: raw }, 'pilot')[key], key).toBe(true);
    }
  });

  it.each(UNRECOGNISED)('an unrecognised value %j still fails closed', (raw) => {
    for (const key of CASHIER_KEYS) {
      expect(parseFeatureFlags({ [FEATURE_FLAG_ENV[key]]: raw }, 'pilot')[key], key).toBe(false);
    }
  });

  it('keeps voucherTender, cardTender, shiftCashup and saleVoid off unless set', () => {
    const flags = parseFeatureFlags({}, 'pilot');
    for (const key of TRUTHY_ONLY_KEYS) expect(flags[key], key).toBe(false);
    for (const key of TRUTHY_ONLY_KEYS) {
      expect(parseFeatureFlags({ [FEATURE_FLAG_ENV[key]]: 'off' }, 'pilot')[key], key).toBe(false);
      expect(parseFeatureFlags({ [FEATURE_FLAG_ENV[key]]: 'on' }, 'pilot')[key], key).toBe(true);
    }
  });

  it('leaves returns exactly as today (default on, explicit falsy off, odd value off)', () => {
    expect(parseFeatureFlags({}, 'pilot').returns).toBe(true);
    expect(parseFeatureFlags({ [FEATURE_FLAG_ENV.returns]: 'off' }, 'pilot').returns).toBe(false);
    expect(parseFeatureFlags({ [FEATURE_FLAG_ENV.returns]: 'on' }, 'pilot').returns).toBe(true);
    expect(parseFeatureFlags({ [FEATURE_FLAG_ENV.returns]: 'odd' }, 'pilot').returns).toBe(false);
  });
});

describe('every other lane, or no baked file, resolves exactly as today (criterion 2)', () => {
  const envs: readonly Record<string, string | undefined>[] = [
    {},
    ...ALL_KEYS.flatMap((key) =>
      [...TRUTHY, ...FALSY, ...UNRECOGNISED, ''].map((raw) => ({ [FEATURE_FLAG_ENV[key]]: raw })),
    ),
  ];

  it.each([['lab'], ['production'], [undefined]])('lane %s matches the no-lane result', (lane) => {
    for (const env of envs) {
      expect(parseFeatureFlags(env, lane)).toEqual(parseFeatureFlags(env));
    }
  });

  it('the cashier switches stay off with no environment value on lab, production and no lane', () => {
    for (const lane of ['lab', 'production', undefined]) {
      const flags = parseFeatureFlags({}, lane);
      for (const key of CASHIER_KEYS) expect(flags[key], `${String(lane)} ${key}`).toBe(false);
    }
  });
});

describe('resolveFeatureFlags reads process.env and the baked lane (RT-1376 scope 1)', () => {
  beforeEach(() => {
    for (const name of Object.values(FEATURE_FLAG_ENV)) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setBakedLaneConfig(null);
  });

  it('no baked file: every switch resolves as today', () => {
    setBakedLaneConfig(null);
    expect(resolveFeatureFlags()).toEqual(parseFeatureFlags({}));
  });

  it.each([['lab'], ['production']] as const)('lane %s: every switch resolves as today', (lane) => {
    setBakedLaneConfig({ lane });
    expect(resolveFeatureFlags()).toEqual(parseFeatureFlags({}));
  });

  it('lane pilot: the four cashier switches are on with no environment variable', () => {
    setBakedLaneConfig({ lane: 'pilot' });
    const flags = resolveFeatureFlags();
    for (const key of CASHIER_KEYS) expect(flags[key], key).toBe(true);
    for (const key of TRUTHY_ONLY_KEYS) expect(flags[key], key).toBe(false);
    expect(flags.returns).toBe(true);
  });

  it('lane pilot: the environment is read per call, and an explicit falsy value wins', () => {
    setBakedLaneConfig({ lane: 'pilot' });
    expect(resolveFeatureFlags().cart).toBe(true);
    vi.stubEnv(FEATURE_FLAG_ENV.cart, '0');
    expect(resolveFeatureFlags().cart).toBe(false);
    vi.stubEnv(FEATURE_FLAG_ENV.cart, '1');
    expect(resolveFeatureFlags().cart).toBe(true);
  });

  it('the lane is read per call: a holder replaced later changes the result', () => {
    setBakedLaneConfig(null);
    expect(resolveFeatureFlags().cart).toBe(false);
    setBakedLaneConfig({ lane: 'pilot' });
    expect(resolveFeatureFlags().cart).toBe(true);
  });
});

describe('the baked file reaches the resolver through the real loader (RT-1376)', () => {
  beforeEach(() => {
    for (const name of Object.values(FEATURE_FLAG_ENV)) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setBakedLaneConfig(null);
  });

  it('a baked pilot file turns the four cashier switches on', () => {
    setBakedLaneConfig(loadLaneConfig('lane-config.json', undefined, () => '{"lane":"pilot"}'));
    const flags = resolveFeatureFlags();
    for (const key of CASHIER_KEYS) expect(flags[key], key).toBe(true);
  });

  it.each([['{"lane":"pilot","unknown":"x"}'], ['not json'], ['{"lane":"retail"}']])(
    'a refused baked file (%s) leaves every switch as today (off)',
    (text) => {
      setBakedLaneConfig(loadLaneConfig('lane-config.json', undefined, () => text));
      expect(resolveFeatureFlags()).toEqual(parseFeatureFlags({}));
    },
  );

  it('an absent baked file leaves every switch as today (off)', () => {
    const absent = (): string => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    setBakedLaneConfig(loadLaneConfig('lane-config.json', undefined, absent));
    expect(resolveFeatureFlags()).toEqual(parseFeatureFlags({}));
  });
});

describe('the RT-162 D-1 refusal fires on the resolved profile (criterion 4)', () => {
  beforeEach(() => {
    for (const name of Object.values(FEATURE_FLAG_ENV)) vi.stubEnv(name, undefined);
    setBakedLaneConfig({ lane: 'pilot' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setBakedLaneConfig(null);
  });

  it('a clean pilot build resolves a launchable profile', () => {
    expect(assessCashierProfile(resolveFeatureFlags())).toEqual({ ok: true });
  });

  it('a pilot build whose saleFinalization is turned off by the environment refuses to start', () => {
    vi.stubEnv(FEATURE_FLAG_ENV.saleFinalization, '0');
    expect(assessCashierProfile(resolveFeatureFlags())).toEqual({
      ok: false,
      reason: 'payments_without_sale_finalization',
    });
  });

  it('turning payments off too is the permitted rollback', () => {
    vi.stubEnv(FEATURE_FLAG_ENV.saleFinalization, '0');
    vi.stubEnv(FEATURE_FLAG_ENV.payments, '0');
    expect(assessCashierProfile(resolveFeatureFlags())).toEqual({ ok: true });
  });
});

describe('no caller bypasses the resolution point (criterion 3)', () => {
  const MAIN_ROOT = resolve(__dirname, '../..');
  const POINT = resolve(MAIN_ROOT, 'app/feature-flags.ts');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
      return /\.(?:tsx?|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  const files = sourceFiles(MAIN_ROOT).filter((file) => file !== POINT);
  // The preload bridge and the build scripts must not read the switches either.
  const POS_ROOT = resolve(MAIN_ROOT, '../..');
  const allFiles = [
    ...files,
    ...sourceFiles(resolve(POS_ROOT, 'src/preload')),
    ...sourceFiles(resolve(POS_ROOT, 'scripts')),
  ];

  it('scans the main process (guards against an empty glob)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith(join('bootstrap', 'payments-cart.ts')))).toBe(true);
  });

  it.each([
    [
      'bootstrap/payments-cart.ts',
      /isCardTenderEnabled = \(\): boolean => resolveFeatureFlags\(\)\.cardTender/,
    ],
    ['bootstrap/returns.ts', /isEnabled: \(\) => resolveFeatureFlags\(\)\.returns/],
    ['bootstrap/sale-void.ts', /isEnabled: \(\) => resolveFeatureFlags\(\)\.saleVoid/],
    ['bootstrap/shift.ts', /isEnabled: \(\) => resolveFeatureFlags\(\)\.shiftCashup/],
    ['payments/cash-shift-gate.ts', /\(\) => resolveFeatureFlags\(\)\.shiftCashup/],
    ['index.ts', /cfg\.features = resolveFeatureFlags\(\)/],
  ])('%s reads the resolved profile', (file, gate) => {
    expect(readFileSync(resolve(MAIN_ROOT, file), 'utf-8')).toMatch(gate);
  });

  it('only app/feature-flags.ts calls parseFeatureFlags', () => {
    const offenders = files.filter((file) =>
      /\bparseFeatureFlags\b/.test(readFileSync(file, 'utf-8')),
    );
    expect(offenders.map((file) => relative(MAIN_ROOT, file))).toEqual([]);
  });

  it('only app/feature-flags.ts imports FEATURE_FLAG_ENV (no indirect env read)', () => {
    const offenders = allFiles.filter((file) =>
      /FEATURE_FLAG_ENV/.test(readFileSync(file, 'utf-8')),
    );
    expect(offenders.map((file) => relative(POS_ROOT, file))).toEqual([]);
  });

  it('nothing outside app/feature-flags.ts reads a feature switch from the environment', () => {
    const names = Object.values(FEATURE_FLAG_ENV).join('|');
    const direct = new RegExp(`(?:process\\.env|env)\\s*(?:\\.|\\[\\s*['"])(?:${names})\\b`);
    const offenders = allFiles.filter((file) => direct.test(readFileSync(file, 'utf-8')));
    expect(offenders.map((file) => relative(POS_ROOT, file))).toEqual([]);
  });
});
