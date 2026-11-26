import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_388_VARIANCE_POLICY_REPIN_BRANCH,
  RT_388_VARIANCE_POLICY_REPIN_EXEMPT_FILES,
  isRt388VariancePolicyRepinExemptFile,
} from './source-scope-guard.const';

/**
 * RT-388 — the exemption that lets the repin to 3f3e96e7e (adds `cash-variance-policy.openapi.yaml`)
 * regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'ccr-bea21095-o3cxj5-rt388';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-388 repin exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_388_VARIANCE_POLICY_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_388_VARIANCE_POLICY_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt388VariancePolicyRepinExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the repin branch', (file) => {
    expect(isRt388VariancePolicyRepinExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'ccr-bea21095-o3cxj5-rt388-preflight',
    'ccr-bea21095-o3cxj5-rt388/extra',
    'ccr-bea21095-o3cxj5-rt38',
    'rt-1578-s3-ats-2e2482',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt388VariancePolicyRepinExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt388VariancePolicyRepinExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1587AvailabilityRepinExemptFile\(currentBranch, file\) &&\s*!isRt388VariancePolicyRepinExemptFile\(currentBranch, file\)/,
    );
  });
});
