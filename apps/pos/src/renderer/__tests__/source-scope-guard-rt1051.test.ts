import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1051_BOUND_ARRAYS_BRANCH,
  RT_1051_BOUND_ARRAYS_EXEMPT_FILES,
  isRt1051ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1051 — the exemption that lets the repin to the bounded Backend-Core
 * contracts regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'fix/rt-1051-bound-request-arrays';
const EXEMPT_FILES = ['src/shared/api-types.ts'];

describe('source-scope guard — RT-1051 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1051_BOUND_ARRAYS_EXEMPT_FILES]).toEqual(EXEMPT_FILES);
    expect(RT_1051_BOUND_ARRAYS_BRANCH).toBe(BRANCH);
  });

  it('allows src/shared/api-types.ts on the RT-1051 branch', () => {
    expect(isRt1051ExemptFile(BRANCH, 'src/shared/api-types.ts')).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/network.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1051 branch', (file) => {
    expect(isRt1051ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'fix/rt-1051-bound-request-arrays-x',
    'fix/rt-1051-bound-request-arrays/extra',
    'fix/rt-1051',
    'bot/backend-core-repin',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    for (const file of EXEMPT_FILES) {
      expect(isRt1051ExemptFile(branch, file), `${branch} ${file}`).toBe(false);
    }
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1051ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt889ExemptFile\(currentBranch, file\) &&\s*!isRt1051ExemptFile\(currentBranch, file\)/,
    );
  });
});
