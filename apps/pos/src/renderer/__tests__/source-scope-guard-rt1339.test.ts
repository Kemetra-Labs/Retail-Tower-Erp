import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1339_OFFERS_REPIN_BRANCH,
  RT_1339_OFFERS_REPIN_EXEMPT_FILES,
  isRt1339ExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1339 — the exemption that lets the repin to the Offer Pack contract (`offers.openapi.yaml`)
 * regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'claude/rt-1339-pos-offers-5cf01b';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-1339 exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1339_OFFERS_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_1339_OFFERS_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt1339ExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the RT-1339 branch', (file) => {
    expect(isRt1339ExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'claude/rt-1339-pos-offers-5cf01b-preflight',
    'claude/rt-1339-pos-offers-5cf01b/extra',
    'claude/rt-1339-pos-offers',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt1339ExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1339ExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1348ExemptFile\(currentBranch, file\) &&\s*!isRt1339ExemptFile\(currentBranch, file\)/,
    );
  });
});
