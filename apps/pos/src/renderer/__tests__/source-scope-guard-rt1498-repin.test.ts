import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1498_CLOSE_REPIN_BRANCH,
  RT_1498_CLOSE_REPIN_EXEMPT_FILES,
  isRt1498CloseRepinExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1498 close slice — the exemption that lets the repin of `pos-sales/sales.yaml` to ef40cdd83
 * (RT-1548) regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'rt-1498-close-unknown-return';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-1498 close-slice repin exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1498_CLOSE_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_1498_CLOSE_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt1498CloseRepinExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the repin branch', (file) => {
    expect(isRt1498CloseRepinExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'rt-1498-close-unknown-return-preflight',
    'rt-1498-close-unknown-return/extra',
    'rt-1498-unknown-return',
    'rt-1498-s4s5-unknown-dispositions',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt1498CloseRepinExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1498CloseRepinExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1403RepinExemptFile\(currentBranch, file\) &&\s*!isRt1498CloseRepinExemptFile\(currentBranch, file\)/,
    );
  });
});
