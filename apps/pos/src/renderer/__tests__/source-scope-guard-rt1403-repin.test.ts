import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1403_REPIN_AFTER_MERGE_BRANCH,
  RT_1403_REPIN_AFTER_MERGE_EXEMPT_FILES,
  isRt1403RepinExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1403 follow-up — the exemption that lets the post-merge repin of `pos-sales/sales.yaml` regenerate
 * `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'rt-1403-repin-after-merge';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-1403 post-merge repin exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1403_REPIN_AFTER_MERGE_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_1403_REPIN_AFTER_MERGE_BRANCH).toBe(BRANCH);
    expect(isRt1403RepinExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the repin branch', (file) => {
    expect(isRt1403RepinExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'rt-1403-repin-after-merge-preflight',
    'rt-1403-repin-after-merge/extra',
    'rt-1403-cashier-device-path-void',
    'rt-1403-repin',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt1403RepinExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1403RepinExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt592RepinExemptFile\(currentBranch, file\) &&\s*!isRt1403RepinExemptFile\(currentBranch, file\)/,
    );
  });
});
