import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1372_OD10_REPIN_BRANCH,
  RT_1372_OD10_REPIN_EXEMPT_FILES,
  isRt1372ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1372 — the exemption that lets the repin to the RT-1367 PR 2 contract commit regenerate
 * `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'claude/rt-1372-pos-od10-guidance';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-1372 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1372_OD10_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_1372_OD10_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt1372ExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1372 branch', (file) => {
    expect(isRt1372ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'claude/rt-1372-pos-od10-guidance-preflight',
    'claude/rt-1372-pos-od10-guidance/extra',
    'rt-1343-credit-void-voucher',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt1372ExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1372ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1343CreditVoidExemptFile\(currentBranch, file\) &&\s*!isRt1372ExemptFile\(currentBranch, file\)( &&|,)/,
    );
  });
});
