import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_1348_PAIRING_ORIGIN_BRANCH,
  RT_1348_PAIRING_ORIGIN_EXEMPT_FILES,
  isRt1348ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1348 (RT-1345 S3) — the source-scope guard exemption for the pairing's backend origin is
 * NARROW: exactly eight files under `src/main/pairing/`, on exactly one branch (exact name). The
 * forbidden prefix list is unchanged, so every other `src/main/pairing/` file stays blocked.
 */

const BRANCH = 'claude/rt-1348-pairing-origin-faee33';
const EXEMPT_FILES = [
  'src/main/pairing/__tests__/api-origin.test.ts',
  'src/main/pairing/__tests__/device-auth-detector-accepted.test.ts',
  'src/main/pairing/__tests__/store-api-origin.test.ts',
  'src/main/pairing/__tests__/store.test.ts',
  'src/main/pairing/api-origin.ts',
  'src/main/pairing/device-auth-detector.ts',
  'src/main/pairing/device-token.ts',
  'src/main/pairing/store.ts',
];

describe('source-scope guard — RT-1348 exemption is narrow', () => {
  it('exempts exactly eight files on exactly one branch', () => {
    expect([...RT_1348_PAIRING_ORIGIN_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_1348_PAIRING_ORIGIN_BRANCH).toBe(BRANCH);
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

  it.each(EXEMPT_FILES)('allows %s on the RT-1348 branch', (file) => {
    expect(isRt1348ExemptFile(BRANCH, file)).toBe(true);
  });

  it.each([
    'src/main/pairing/service.ts',
    'src/main/pairing/network.ts',
    'src/main/pairing/token-binding.ts',
    'src/main/pairing/failure-mapping.ts',
    'src/main/pairing/store.ts.orig',
    'src/main/pairing/__tests__/service.test.ts',
    'src/main/secrets/store.ts',
    'src/shared/api-types.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1348 branch', (file) => {
    expect(isRt1348ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'claude/rt-1348-pairing-origin-faee33-preflight',
    'claude/rt-1348-pairing-origin-faee33/extra',
    'claude/rt-1348-pairing-origin',
    'claude/rt-1349-clean-device',
    '',
  ])('does not allow the files on branch %j', (branch) => {
    for (const file of EXEMPT_FILES) {
      expect(isRt1348ExemptFile(branch, file), `${branch} ${file}`).toBe(false);
    }
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-scope-guard.test.ts'),
      'utf8',
    );
    expect(guard.match(/isRt1348ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1114ExemptFile\(currentBranch, file\) &&\s*!isRt1348ExemptFile\(currentBranch, file\)/,
    );
  });
});
