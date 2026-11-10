import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PATH_PREFIXES,
  RT_1316_STORE_NAME_BRANCH,
  RT_1316_STORE_NAME_EXEMPT_FILES,
  isRt1316ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1316 Phase 2 — the source-scope guard exemption for the store-name projection is NARROW:
 * exactly the pairing store and its unit test, on exactly one branch (exact name). The
 * forbidden prefix list is unchanged, so every other `src/main/pairing/` file stays blocked.
 */

const BRANCH = 'claude/rt-1316-pos-pairing-557e08';
const EXEMPT_FILES = ['src/main/pairing/__tests__/store.test.ts', 'src/main/pairing/store.ts'];

describe('source-scope guard — RT-1316 exemption is narrow', () => {
  it('exempts exactly two files on exactly one branch', () => {
    expect([...RT_1316_STORE_NAME_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_1316_STORE_NAME_BRANCH).toBe(BRANCH);
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

  it.each(EXEMPT_FILES)('allows %s on the RT-1316 branch', (file) => {
    expect(isRt1316ExemptFile(BRANCH, file)).toBe(true);
  });

  it.each([
    'src/main/pairing/service.ts',
    'src/main/pairing/network.ts',
    'src/main/pairing/store.ts.orig',
    'src/main/pairing/__tests__/service.test.ts',
    'src/main/secrets/store.ts',
    'src/shared/api-types.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1316 branch', (file) => {
    expect(isRt1316ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'claude/rt-1316-pos-pairing-557e08-preflight',
    'claude/rt-1316-pos-pairing-557e08/extra',
    'claude/rt-1316-pos-pairing',
    'claude/rt-1316-console-pairing',
    '',
  ])('does not allow the files on branch %j', (branch) => {
    for (const file of EXEMPT_FILES) {
      expect(isRt1316ExemptFile(branch, file), `${branch} ${file}`).toBe(false);
    }
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'source-scope-guard.test.ts'),
      'utf8',
    );
    expect(guard.match(/isRt1316ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1110ExemptFile\(currentBranch, file\) &&\s*!isRt1316ExemptFile\(currentBranch, file\)/,
    );
  });
});
