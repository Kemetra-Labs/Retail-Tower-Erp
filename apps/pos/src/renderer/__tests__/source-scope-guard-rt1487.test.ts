import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_1487_CATALOG_DELTAS_BRANCH,
  RT_1487_CATALOG_DELTAS_EXEMPT_FILES,
  isRt1487ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1487 — the source-scope guard exemption for the catalogue delta route is NARROW: exactly
 * the device-401 detector and its unit test, on exactly one branch (exact name). The forbidden
 * prefix list is unchanged, so every other `src/main/pairing/` file stays blocked.
 */

const BRANCH = 'claude/rt-1487-pos-catalog-deltas';
const EXEMPT_FILES = [
  'src/main/pairing/__tests__/device-auth-detector.test.ts',
  'src/main/pairing/device-auth-detector.ts',
];

describe('source-scope guard — RT-1487 exemption is narrow', () => {
  it('exempts exactly two files on exactly one branch', () => {
    expect([...RT_1487_CATALOG_DELTAS_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_1487_CATALOG_DELTAS_BRANCH).toBe(BRANCH);
  });

  it('does not touch the forbidden prefix list', () => {
    expect([...FORBIDDEN_PATH_PREFIXES]).toEqual([
      'src/main/pairing/',
      'src/main/secrets/',
      'src/shared/api-types.ts',
      'scripts/codegen-api.ts',
      'scripts/openapi-snapshot.json',
      '.github/workflows/',
    ]);
  });

  it.each(EXEMPT_FILES)('allows %s on the RT-1487 branch', (file) => {
    expect(isRt1487ExemptFile(BRANCH, file)).toBe(true);
  });

  it.each([
    'src/main/pairing/store.ts',
    'src/main/pairing/network.ts',
    'src/main/pairing/device-auth-detector.ts.orig',
    'src/main/pairing/__tests__/device-auth-detector-accepted.test.ts',
    'src/main/secrets/store.ts',
    'src/shared/api-types.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1487 branch', (file) => {
    expect(isRt1487ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'claude/rt-1487-pos-catalog-deltas-preflight',
    'claude/rt-1487-pos-catalog-deltas/extra',
    'claude/rt-1487-pos-catalog',
    'claude/rt-1316-pos-pairing-557e08',
    '',
  ])('does not allow the files on branch %j', (branch) => {
    for (const file of EXEMPT_FILES) {
      expect(isRt1487ExemptFile(branch, file), `${branch} ${file}`).toBe(false);
    }
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-scope-guard.test.ts'),
      'utf8',
    );
    expect(guard.match(/isRt1487ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /ExemptFile\(currentBranch, file\) &&\s*!isRt1487ExemptFile\(currentBranch, file\)/,
    );
  });
});
