import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1110_VOUCHER_REPIN_BRANCH,
  RT_1110_VOUCHER_REPIN_EXEMPT_FILES,
  isRt1110ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1110 — the exemption that lets the repin to the amended voucher contract V-A regenerate
 * `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'claude/rt-1110-voucher-va-amendment';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-1110 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1110_VOUCHER_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_1110_VOUCHER_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt1110ExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1110 branch', (file) => {
    expect(isRt1110ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'claude/rt-1110-voucher-va-amendment-x',
    'claude/rt-1110-voucher-va-amendment/extra',
    'claude/rt-1181-pos-pin-repin',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt1110ExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1110ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1253ExemptFile\(currentBranch, file\) &&\s*!isRt1110ExemptFile\(currentBranch, file\)/,
    );
  });
});
