import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RT_1587_AVAILABILITY_REPIN_BRANCH,
  RT_1587_AVAILABILITY_REPIN_EXEMPT_FILES,
  isRt1587AvailabilityRepinExemptFile,
} from './source-scope-guard.const';

/**
 * RT-1587 — the exemption that lets the repin to 58e0b8691 (RT-1587, `pos-availability.yaml` nextCursor and wording)
 * regenerate `src/shared/api-types.ts` is narrow: one file, one branch.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'ccr-bea21095-o3cxj5-rt1587';
const FILE = 'src/shared/api-types.ts';

describe('source-scope guard — RT-1587 repin exemption is narrow', () => {
  it('exempts exactly one file on exactly one branch', () => {
    expect([...RT_1587_AVAILABILITY_REPIN_EXEMPT_FILES]).toEqual([FILE]);
    expect(RT_1587_AVAILABILITY_REPIN_BRANCH).toBe(BRANCH);
    expect(isRt1587AvailabilityRepinExemptFile(BRANCH, FILE)).toBe(true);
  });

  it.each([
    'scripts/codegen-api.ts',
    'scripts/openapi-snapshot.json',
    'src/shared/api-types.ts.orig',
    'src/main/pairing/service.ts',
    'src/main/secrets/store.ts',
    '.github/workflows/ci.yml',
  ])('does not allow %s on the repin branch', (file) => {
    expect(isRt1587AvailabilityRepinExemptFile(BRANCH, file)).toBe(false);
  });

  it.each([
    'main',
    'ccr-bea21095-o3cxj5-rt1587-preflight',
    'ccr-bea21095-o3cxj5-rt1587/extra',
    'ccr-bea21095-o3cxj5-rt158',
    'rt-1578-s3-ats-2e2482',
    '',
  ])('does not allow the file on branch %j', (branch) => {
    expect(isRt1587AvailabilityRepinExemptFile(branch, FILE)).toBe(false);
  });

  it('the guard consults the exemption exactly once, as a filter on the violations', () => {
    const guard = readFileSync(path.join(HERE, 'source-scope-guard.test.ts'), 'utf8');
    expect(guard.match(/isRt1587AvailabilityRepinExemptFile/g)).toHaveLength(2); // import + use
    expect(guard).toMatch(
      /!isRt1578AvailabilityRepinExemptFile\(currentBranch, file\) &&\s*!isRt1587AvailabilityRepinExemptFile\(currentBranch, file\)/,
    );
  });
});
